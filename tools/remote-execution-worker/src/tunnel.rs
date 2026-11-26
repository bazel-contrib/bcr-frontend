use std::{
    fs, io::Write, net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{Connection, RecvStream, SendStream, presets},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

pub const ALPN: &[u8] = b"bcr/remote-execution-worker/1";
const PREFIX: &str = "bcr-rex-worker-v1:";
const CREDENTIAL_PREFIX: &str = "bcr-iroh-worker-v1";
pub const MAX_WORKER_CREDENTIAL: usize = 320;

#[derive(Deserialize, Serialize)]
pub struct Ticket {
    pub endpoint: EndpointId,
    pub relay: RelayUrl,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
}

impl Ticket {
    pub fn decode(text: &str) -> Result<Self> {
        ensure!(text.len() <= 4096, "Iroh worker ticket is too large");
        let data = text
            .trim()
            .strip_prefix(PREFIX)
            .context("invalid Iroh worker ticket")?;
        let ticket: Self = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(data)?)?;
        validate_token(&ticket.token)?;
        Ok(ticket)
    }

    pub fn encode(&self) -> Result<String> {
        validate_token(&self.token)?;
        Ok(format!(
            "{PREFIX}{}\n",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }
}

pub fn validate_token(token: &str) -> Result<()> {
    ensure!(
        (24..=256).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_graphic()),
        "invalid worker token"
    );
    Ok(())
}

pub fn identity(path: &Path) -> Result<SecretKey> {
    match fs::read(path) {
        Ok(bytes) => {
            ensure!(
                fs::metadata(path)?.permissions().mode() & 0o077 == 0,
                "private key file permissions required"
            );
            return Ok(SecretKey::from_bytes(
                &bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("invalid Iroh key"))?,
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let key = SecretKey::generate();
    let parent = path
        .parent()
        .filter(|part| !part.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&key.to_bytes())?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(path) {
        Ok(_) => Ok(key),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => identity(path),
        Err(error) => Err(error.into()),
    }
}

async fn endpoint(relay: &RelayUrl, key: Option<SecretKey>) -> Result<Endpoint> {
    let mut builder = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Custom(RelayMap::from_iter([relay.clone()])));
    if let Some(key) = key {
        builder = builder.secret_key(key);
    }
    Ok(builder.bind().await?)
}

async fn relay(tcp: TcpStream, mut send: SendStream, mut receive: RecvStream) -> Result<()> {
    let (mut read, mut write) = tcp.into_split();
    let request = async {
        tokio::io::copy(&mut read, &mut send).await?;
        send.finish()?;
        Ok::<_, anyhow::Error>(())
    };
    let response = async {
        tokio::io::copy(&mut receive, &mut write).await?;
        write.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::try_join!(request, response)?;
    Ok(())
}

pub async fn client(ticket: Ticket, key: Option<SecretKey>) -> Result<(String, String)> {
    let peer = EndpointAddr::new(ticket.endpoint).with_relay_url(ticket.relay.clone());
    let base = endpoint(&ticket.relay, key).await?;
    let credential = if ticket.pool.is_some() {
        timeout(Duration::from_secs(10), async {
            let conn = base.connect(peer.clone(), ALPN).await?;
            let (mut send, mut receive) = conn.open_bi().await?;
            send.write_all(&[0, 0]).await?;
            send.write_all(&(ticket.token.len() as u16).to_be_bytes())
                .await?;
            send.write_all(ticket.token.as_bytes()).await?;
            send.finish()?;
            let response = receive.read_to_end(MAX_WORKER_CREDENTIAL).await?;
            ensure!(!response.is_empty(), "the Iroh gateway rejected enrollment");
            Ok::<_, anyhow::Error>(String::from_utf8(response)?)
        })
        .await
        .context("timed out enrolling Iroh worker")??
    } else {
        ticket.token.clone()
    };
    let local = TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", local.local_addr()?);
    let token = Arc::new(ticket.token);
    let limit = Arc::new(Semaphore::new(16));
    tokio::spawn(async move {
        while let Ok((tcp, _)) = local.accept().await {
            let Ok(permit) = limit.clone().try_acquire_owned() else {
                continue;
            };
            let (base, peer, token) = (base.clone(), peer.clone(), token.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let stream = timeout(Duration::from_secs(10), async {
                    let connection = base.connect(peer, ALPN).await?;
                    let (mut send, receive) = connection.open_bi().await?;
                    send.write_all(&(token.len() as u16).to_be_bytes()).await?;
                    send.write_all(token.as_bytes()).await?;
                    Ok::<_, anyhow::Error>((connection, send, receive))
                })
                .await;
                if let Ok(Ok((_connection, send, receive))) = stream {
                    let _ = relay(tcp, send, receive).await;
                }
            });
        }
    });
    Ok((origin, credential))
}

pub async fn gateway(relay_url: &RelayUrl, key: SecretKey) -> Result<Endpoint> {
    endpoint(relay_url, Some(key)).await
}

pub struct GatewayToken {
    pub pool: Option<String>,
    pub token: String,
}

async fn read_token(receive: &mut RecvStream, size: usize) -> Result<Vec<u8>> {
    ensure!((24..=256).contains(&size), "invalid Iroh worker credential");
    let mut credential = vec![0; size];
    receive.read_exact(&mut credential).await?;
    Ok(credential)
}

pub async fn serve_connection(
    connection: Connection,
    backend: SocketAddr,
    tokens: Arc<Vec<GatewayToken>>,
    gateway_key: Arc<SecretKey>,
    limit: Arc<Semaphore>,
) {
    let peer = connection.remote_id();
    while let Ok((mut send, mut receive)) = connection.accept_bi().await {
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            let _ = send.reset(1u32.into());
            continue;
        };
        let tokens = tokens.clone();
        let gateway_key = gateway_key.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let upstream = timeout(Duration::from_secs(5), async {
                let mut size = [0; 2];
                receive.read_exact(&mut size).await?;
                let size = u16::from_be_bytes(size) as usize;
                if size == 0 {
                    let mut size = [0; 2];
                    receive.read_exact(&mut size).await?;
                    let credential =
                        read_token(&mut receive, u16::from_be_bytes(size) as usize).await?;
                    let pool = tokens
                        .iter()
                        .find_map(|entry| {
                            entry
                                .pool
                                .as_ref()
                                .filter(|_| bool::from(entry.token.as_bytes().ct_eq(&credential)))
                        })
                        .context("invalid Iroh pool enrollment credential")?;
                    let claim = format!("{CREDENTIAL_PREFIX}:{pool}:{peer}");
                    let signature =
                        URL_SAFE_NO_PAD.encode(gateway_key.sign(claim.as_bytes()).to_bytes());
                    send.write_all(format!("{claim}:{signature}").as_bytes())
                        .await?;
                    send.finish()?;
                    return Ok::<_, anyhow::Error>(None);
                }
                let credential = read_token(&mut receive, size).await?;
                let mut authorized = subtle::Choice::from(0);
                for token in tokens.iter() {
                    authorized |= token.token.as_bytes().ct_eq(&credential);
                }
                ensure!(bool::from(authorized), "invalid Iroh worker credential");
                Ok(Some(TcpStream::connect(backend).await?))
            })
            .await;
            if let Ok(Ok(Some(tcp))) = upstream {
                let _ = timeout(Duration::from_secs(600), relay(tcp, send, receive)).await;
            }
        });
    }
}
