use std::{
    fs,
    io::Write,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use iroh::RelayUrl;
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::Semaphore,
    time::timeout,
};

use remote_execution_tunnel as tunnel;
use tunnel::{GatewayToken, Ticket};

#[derive(Parser)]
#[command(about = "Expose the loopback execution worker listener over Iroh")]
struct Options {
    #[arg(long)]
    relay: RelayUrl,
    /// Loopback address from bazel_backend --http_listen or --remote_execution_http_listen.
    #[arg(long)]
    backend: SocketAddr,
    #[arg(long)]
    key_file: PathBuf,
    #[arg(long)]
    ticket_dir: PathBuf,
    /// A worker token file in the form WORKER_ID=PATH. Repeat for each worker.
    #[arg(long = "worker-token", required_unless_present = "pools")]
    tokens: Vec<String>,
    /// Reusable pool enrollment token file in the form POOL_ID=PATH.
    #[arg(long = "pool-token")]
    pools: Vec<String>,
}

fn private_file(path: &Path) -> Result<String> {
    ensure!(
        fs::metadata(path)?.permissions().mode() & 0o077 == 0,
        "private file permissions required"
    );
    Ok(fs::read_to_string(path)?)
}

fn write_file(path: &Path, contents: &str) -> Result<()> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().context("missing ticket directory")?)?;
    file.write_all(contents.as_bytes())?;
    file.persist(path)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = Options::parse();
    ensure!(
        options.backend.ip().is_loopback(),
        "use a loopback worker backend"
    );
    let key = Arc::new(tunnel::identity(&options.key_file)?);
    let base = tunnel::gateway(&options.relay, key.as_ref().clone()).await?;
    timeout(Duration::from_secs(15), base.online())
        .await
        .context("Iroh relay did not become ready")?;
    fs::create_dir_all(&options.ticket_dir)?;
    let mut tokens: Vec<GatewayToken> = Vec::new();
    let mut tickets = std::collections::HashSet::new();
    for (item, is_pool) in options
        .tokens
        .iter()
        .map(|item| (item, false))
        .chain(options.pools.iter().map(|item| (item, true)))
    {
        let (id, path) = item.split_once('=').context("expected ID=PATH")?;
        ensure!(
            id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')),
            "invalid worker or pool ID"
        );
        let token = private_file(Path::new(path))?.trim().to_owned();
        ensure!(
            !tokens.iter().any(|entry| entry.token == token),
            "reuse a ticket instead of configuring a duplicate enrollment token"
        );
        let pool = is_pool.then(|| id.to_owned());
        let ticket = Ticket {
            endpoint: base.id(),
            relay: options.relay.clone(),
            token: token.clone(),
            pool: pool.clone(),
        };
        let filename = if is_pool {
            format!("pool-{id}.ticket")
        } else {
            format!("{id}.ticket")
        };
        ensure!(
            tickets.insert(filename.clone()),
            "duplicate ticket filename"
        );
        write_file(&options.ticket_dir.join(filename), &ticket.encode()?)?;
        tokens.push(GatewayToken { pool, token });
    }
    write_file(
        &options.ticket_dir.join("gateway.id"),
        &format!("{}\n", base.id()),
    )?;
    let tokens = Arc::new(tokens);
    let limit = Arc::new(Semaphore::new(128));
    let connections = Arc::new(Semaphore::new(128));
    let mut terminate = signal(SignalKind::terminate())?;
    eprintln!("Iroh worker gateway ready at {}", base.id());
    loop {
        tokio::select! {
            incoming = base.accept() => {
                let Some(incoming) = incoming else {break};
                let Ok(permit) = connections.clone().try_acquire_owned() else {continue};
                let (tokens, key, limit) = (tokens.clone(), key.clone(), limit.clone());
                let backend = options.backend;
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok(connection)) = timeout(Duration::from_secs(5), incoming).await {
                        if connection.alpn() == tunnel::ALPN {
                            tunnel::serve_connection(connection, backend, tokens, key, limit).await;
                        }
                    }
                });
            }
            _ = terminate.recv() => break,
        }
    }
    base.close().await;
    Ok(())
}
