use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::Parser;
use invocation_iroh::{
    ALPN, MAX_REQUEST, MAX_SUMMARY, Operation, Request, Ticket, valid_group_name,
    valid_invocation_id,
};
use iroh::{
    Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{Connection, RecvStream, SendStream, presets},
    protocol::{AcceptError, ProtocolHandler, Router},
};
use reqwest::Client;
use subtle::ConstantTimeEq;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, timeout, timeout_at},
};

#[derive(Parser)]
#[command(about = "Serve a local bazel_backend invocation API to authorized Iroh viewers")]
struct Options {
    /// Port of bazel_backend's local HTTP invocation API.
    #[arg(long, default_value_t = 1974)]
    backend_port: u16,
    /// Private key path. A key is created with mode 0600 if it is missing.
    #[arg(long)]
    key_file: PathBuf,
    /// Override the Iroh relay. HTTP is accepted only for a loopback relay.
    #[arg(long)]
    relay: Option<RelayUrl>,
    /// Limit this ticket to a specific invocation.
    #[arg(long)]
    invocation: Option<String>,
    /// Issue a Remote Execution viewer ticket using this backend credential.
    #[arg(long, conflicts_with = "invocation")]
    execution_viewer_token_file: Option<PathBuf>,
    /// Lifetime of the ticket. Restarting revokes it.
    #[arg(long, default_value_t = 3600, value_parser = clap::value_parser!(u32).range(1..=86_400))]
    ttl_seconds: u32,
}

struct ViewerApi {
    upstream: Client,
    port: u16,
    scope: Option<String>,
    execution_token: Option<String>,
    token: String,
    expires: Instant,
    streams: Arc<Semaphore>,
}

#[derive(Clone)]
struct Viewer(Arc<ViewerApi>);

impl std::fmt::Debug for Viewer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Viewer").finish_non_exhaustive()
    }
}

impl ProtocolHandler for Viewer {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let request_slots = Arc::new(Semaphore::new(8));
        while let Ok((mut send, recv)) = connection.accept_bi().await {
            let Ok(permit) = request_slots.clone().try_acquire_owned() else {
                let _ = send.reset(1u32.into());
                continue;
            };
            let api = self.0.clone();
            tokio::spawn(async move {
                if api.expires <= Instant::now() {
                    let _ = timeout(
                        Duration::from_secs(5),
                        reply(&mut send, 403, b"viewer ticket expired"),
                    )
                    .await;
                    return;
                }
                let _ = timeout_at(api.expires, api.serve(&mut send, recv, permit)).await;
                // Expired, canceled and interrupted requests close this stream.
            });
        }
        Ok(())
    }
}

impl ViewerApi {
    async fn serve(
        &self,
        send: &mut SendStream,
        recv: RecvStream,
        request_slot: OwnedSemaphorePermit,
    ) -> Result<()> {
        let mut recv = recv;
        let request = match timeout(Duration::from_secs(10), recv.read_to_end(MAX_REQUEST)).await {
            Ok(Ok(data)) => serde_json::from_slice::<Request>(&data).ok(),
            _ => None,
        };
        let Some(request) = request else {
            return reply(send, 400, b"invalid request").await;
        };
        if self
            .token
            .as_bytes()
            .ct_eq(request.token.as_bytes())
            .unwrap_u8()
            != 1
        {
            return reply(send, 403, b"connection ticket denied").await;
        }
        let Ok(_stream_slot) = self.streams.try_acquire() else {
            return reply(send, 503, b"viewer stream limit reached").await;
        };
        drop(request_slot);

        let execution = matches!(request.operation, Operation::ExecutionRead { .. });
        if execution != self.execution_token.is_some() {
            return reply(send, 403, b"request outside viewer ticket scope").await;
        }
        let scoped_list = matches!(request.operation, Operation::List) && self.scope.is_some();
        let mut execution_watch = false;
        let path = match &request.operation {
            Operation::List => self.scope.as_ref().map_or_else(
                || "/api/invocations".to_owned(),
                |id| format!("/api/invocations/{id}"),
            ),
            Operation::ListPage { token } => {
                if self.scope.is_some() || !valid_page_token(token) {
                    return reply(send, 400, b"invalid page token").await;
                }
                format!("/api/invocations?page_token={token}")
            }
            Operation::ListGroups
            | Operation::ListGroup { .. }
            | Operation::GroupMetrics { .. } => {
                if self.scope.is_some() {
                    return reply(send, 403, b"group queries require an unscoped ticket").await;
                }
                match &request.operation {
                    Operation::ListGroup { name, token } if valid_group_name(name) => {
                        if let Some(token) = token {
                            if !valid_page_token(token) {
                                return reply(send, 400, b"invalid page token").await;
                            }
                            format!("/api/invocations?group={name}&page_token={token}")
                        } else {
                            format!("/api/invocations?group={name}")
                        }
                    }
                    Operation::GroupMetrics { name, days } if valid_group_name(name) => {
                        if let Some(days) = days {
                            format!("/api/invocation-groups/{name}/metrics?window_days={days}")
                        } else {
                            format!("/api/invocation-groups/{name}/metrics")
                        }
                    }
                    Operation::ListGroups => "/api/invocation-groups".to_owned(),
                    _ => return reply(send, 400, b"invalid invocation group name").await,
                }
            }
            Operation::ExecutionRead { path } => {
                let Some(watch) = execution_path(path) else {
                    return reply(send, 400, b"invalid execution viewer route").await;
                };
                execution_watch = watch;
                format!("/api/remote-execution{path}")
            }
            Operation::Get { id } | Operation::Watch { id, .. } => {
                if !valid_invocation_id(id) {
                    return reply(send, 400, b"invalid invocation ID").await;
                }
                if self.scope.as_ref().is_some_and(|scope| scope != id) {
                    return reply(send, 403, b"invocation outside ticket scope").await;
                }
                match request.operation {
                    Operation::Watch { after, .. } => {
                        format!("/api/invocations/{id}/events?after={after}")
                    }
                    _ => format!("/api/invocations/{id}"),
                }
            }
        };

        let watch = execution_watch || matches!(request.operation, Operation::Watch { .. });
        let mut upstream_request = self
            .upstream
            .get(format!("http://127.0.0.1:{}{path}", self.port));
        if let Some(token) = &self.execution_token {
            upstream_request = upstream_request.bearer_auth(token);
        }
        let mut upstream = match upstream_request.send().await {
            Ok(response) => response,
            Err(_) => return reply(send, 502, b"viewer backend unavailable").await,
        };
        let status = upstream.status().as_u16();
        if status == 404 && scoped_list {
            return reply(send, 200, br#"{"invocations":[]}"#).await;
        }
        if !upstream.status().is_success() {
            return reply(send, status, b"invocation request failed").await;
        }
        if watch {
            send.write_all(&status.to_be_bytes()).await?;
            loop {
                tokio::select! {
                    chunk = upstream.chunk() => match chunk? {
                        Some(bytes) => send.write_all(&bytes).await?,
                        None => break,
                    },
                    _ = send.stopped() => return Ok(()),
                }
            }
            send.finish()?;
            return Ok(());
        }

        let mut body = Vec::new();
        while let Some(chunk) = upstream.chunk().await? {
            if chunk.len() > MAX_SUMMARY - body.len() {
                return reply(send, 502, b"invocation response exceeds the viewer limit").await;
            }
            body.extend_from_slice(&chunk);
        }
        if scoped_list {
            let invocation: serde_json::Value = serde_json::from_slice(&body)?;
            body = serde_json::to_vec(&serde_json::json!({"invocations": [invocation]}))?;
        }
        reply(send, status, &body).await
    }
}

fn execution_path(path: &str) -> Option<bool> {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route == "/status" || route == "/instances" {
        return query.is_empty().then_some(false);
    }
    let parts = route.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    let watch = match parts.as_slice() {
        ["pools"] => false,
        ["pools", pool] | ["pools", pool, "workers" | "operations"] if valid_group_name(pool) => {
            false
        }
        ["pools", pool, "operations", operation]
            if valid_group_name(pool) && valid_invocation_id(operation) =>
        {
            false
        }
        ["pools", pool, "activity"] if valid_group_name(pool) => true,
        ["pools", pool, "timeline"] if valid_group_name(pool) => {
            if query.is_empty()
                || query
                    .strip_prefix("after=")
                    .is_some_and(|cursor| cursor.parse::<u64>().is_ok())
            {
                return Some(false);
            }
            return None;
        }
        ["pools", pool, "workers", worker] | ["pools", pool, "workers", worker, "attempts"]
            if valid_group_name(pool) && valid_group_name(worker) =>
        {
            false
        }
        ["pools", pool, "workers", worker, "activity"]
            if valid_group_name(pool) && valid_group_name(worker) =>
        {
            true
        }
        _ => return None,
    };
    if !query.is_empty() {
        for field in query.split('&') {
            let (name, value) = field.split_once('=')?;
            let allowed = match name {
                "after" if watch => value.parse::<u64>().is_ok(),
                "page_size" if !watch => value.parse::<u32>().is_ok_and(|number| number <= 200),
                "page_token" if !watch => valid_page_token(value),
                _ => false,
            };
            if !allowed {
                return None;
            }
        }
    }
    Some(watch)
}

fn valid_page_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 768
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

async fn reply(send: &mut SendStream, status: u16, body: &[u8]) -> Result<()> {
    send.write_all(&status.to_be_bytes()).await?;
    send.write_all(body).await?;
    send.finish()?;
    Ok(())
}

fn load_key(path: &Path) -> Result<SecretKey> {
    if let Err(err) = fs::metadata(path) {
        if err.kind() != ErrorKind::NotFound {
            return Err(err.into());
        }
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                let key = SecretKey::generate();
                file.write_all(&key.to_bytes())?;
                file.sync_all()?;
                return Ok(key);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => (),
            Err(err) => return Err(err.into()),
        }
    }
    let metadata = fs::metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o077 == 0,
        "the Iroh key file must be a private regular file"
    );
    let data = fs::read(path)?;
    let bytes = data
        .try_into()
        .map_err(|_| anyhow::anyhow!("the Iroh key file must contain 32 raw bytes"))?;
    Ok(SecretKey::from_bytes(&bytes))
}

#[tokio::main]
async fn main() -> Result<()> {
    let options = Options::parse();
    if options
        .invocation
        .as_deref()
        .is_some_and(|id| !valid_invocation_id(id))
    {
        bail!("invalid --invocation ID");
    }
    let secret = load_key(&options.key_file).context("load Iroh identity")?;
    let builder = if let Some(relay) = options.relay {
        ensure!(
            relay.scheme() == "https"
                || (relay.scheme() == "http"
                    && matches!(relay.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
            "the relay must use HTTPS or loopback HTTP"
        );
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom(RelayMap::from_iter([relay])))
    } else {
        Endpoint::builder(presets::N0)
    };
    let endpoint = builder.secret_key(secret).bind().await?;
    timeout(Duration::from_secs(30), endpoint.online())
        .await
        .context("Iroh relay did not become ready")?;
    let token = URL_SAFE_NO_PAD.encode(SecretKey::generate().to_bytes());
    let upstream = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(30))
        .build()?;
    let execution_token = options
        .execution_viewer_token_file
        .as_deref()
        .map(|path| -> Result<_> {
            ensure!(
                fs::metadata(path)?.permissions().mode() & 0o077 == 0,
                "viewer token file must be private"
            );
            let token = fs::read_to_string(path)?.trim().to_owned();
            ensure!((24..=256).contains(&token.len()), "invalid viewer token");
            Ok(token)
        })
        .transpose()?;
    let api = Arc::new(ViewerApi {
        upstream,
        port: options.backend_port,
        scope: options.invocation,
        execution_token,
        token: token.clone(),
        expires: Instant::now() + Duration::from_secs(u64::from(options.ttl_seconds)),
        streams: Arc::new(Semaphore::new(128)),
    });
    let router = Router::builder(endpoint.clone())
        .accept(ALPN, Viewer(api))
        .spawn();
    let endpoint_address = endpoint.addr();
    let relay = endpoint_address
        .relay_urls()
        .next()
        .context("Iroh did not find a relay")?
        .clone();
    let ticket = Ticket {
        endpoint: endpoint.id(),
        relay,
        token,
    };
    println!("Iroh endpoint: {}", ticket.endpoint);
    println!("Viewer ticket: {}", ticket.encode()?);
    tokio::signal::ctrl_c().await?;
    router.shutdown().await?;
    Ok(())
}
