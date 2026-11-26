use std::{net::IpAddr, path::Path, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use prost::Message;
use reqwest::{Client, StatusCode, Url};
use sha2::{Digest as _, Sha256};
use tokio::{fs::File, io::AsyncWriteExt};
use tokio_util::io::ReaderStream;
use worker_protocol::{reapi::Digest, worker::LeaseOffer};

const PREFIX: &str = "api/remote-execution/worker/";
const MAX_MESSAGE: u64 = 16 << 20;

#[derive(Clone)]
pub struct Scheduler {
    client: Client,
    address: Url,
    token: String,
}

impl Scheduler {
    pub fn http(address: &str, token: String) -> Result<Self> {
        let mut address = Url::parse(address).context("invalid scheduler URL")?;
        let loopback = address
            .host_str()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        ensure!(
            address.scheme() == "https" || (address.scheme() == "http" && loopback),
            "use HTTPS or a loopback HTTP scheduler"
        );
        ensure!(
            address.username().is_empty()
                && address.password().is_none()
                && address.query().is_none()
                && address.fragment().is_none()
                && address.path() == "/",
            "expected a scheduler origin"
        );
        address.set_path("/");
        ensure!(
            (24..=remote_execution_tunnel::MAX_WORKER_CREDENTIAL).contains(&token.len()),
            "invalid worker token length"
        );
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()?,
            address,
            token,
        })
    }

    pub async fn rpc<Req: Message, Resp: Message + Default>(
        &self,
        method: &str,
        request: &Req,
    ) -> Result<Resp> {
        let endpoint = self.address.join(&format!("{PREFIX}{method}"))?;
        let mut last = None;
        for attempt in 0..3 {
            let response = self
                .client
                .post(endpoint.clone())
                .bearer_auth(&self.token)
                .header("Content-Type", "application/protobuf")
                .timeout(Duration::from_secs(20))
                .body(request.encode_to_vec())
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let mut response = response;
                    let mut data = Vec::new();
                    while let Some(chunk) = response.chunk().await? {
                        ensure!(
                            data.len() as u64 + chunk.len() as u64 <= MAX_MESSAGE,
                            "scheduler response is too large"
                        );
                        data.extend_from_slice(&chunk);
                    }
                    return Resp::decode(data.as_slice()).context("invalid scheduler response");
                }
                Ok(response) if !response.status().is_server_error() => {
                    bail!("{method}: scheduler returned {}", response.status())
                }
                Ok(response) => last = Some(format!("scheduler returned {}", response.status())),
                Err(error) => last = Some(error.without_url().to_string()),
            }
            tokio::time::sleep(Duration::from_millis(200 << attempt)).await;
        }
        bail!("{method}: {}", last.unwrap_or_default())
    }

    pub fn blobs<'a>(&'a self, session: &'a str, lease: &'a LeaseOffer) -> Blobs<'a> {
        Blobs {
            scheduler: self,
            session,
            lease: &lease.lease_id,
        }
    }
}

pub struct Blobs<'a> {
    scheduler: &'a Scheduler,
    session: &'a str,
    lease: &'a str,
}

fn valid_digest(digest: &Digest) -> bool {
    digest.hash.len() == 64
        && digest
            .hash
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
        && (0..=(4_i64 << 30)).contains(&digest.size_bytes)
}

impl Blobs<'_> {
    fn url(&self, digest: &Digest) -> Result<Url> {
        ensure!(valid_digest(digest), "invalid CAS digest");
        for id in [self.session, self.lease] {
            ensure!(
                !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
                "invalid lease identity"
            );
        }
        Ok(self.scheduler.address.join(&format!(
            "{PREFIX}{}/{}/blobs/{}/{}",
            self.session, self.lease, digest.hash, digest.size_bytes,
        ))?)
    }

    async fn get(&self, digest: &Digest) -> Result<reqwest::Response> {
        let response = self
            .scheduler
            .client
            .get(self.url(digest)?)
            .bearer_auth(&self.scheduler.token)
            .timeout(Duration::from_secs(120))
            .send()
            .await?;
        ensure!(
            response.status() == StatusCode::OK,
            "CAS download returned {}",
            response.status()
        );
        Ok(response)
    }

    pub async fn message<M: Message + Default>(&self, digest: &Digest) -> Result<M> {
        ensure!(
            (0..=MAX_MESSAGE as i64).contains(&digest.size_bytes),
            "CAS message exceeds size limit"
        );
        let mut response = self.get(digest).await?;
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                data.len() + chunk.len() <= digest.size_bytes as usize,
                "CAS message exceeds its digest size"
            );
            data.extend_from_slice(&chunk);
        }
        ensure!(
            &digest_bytes(&data) == digest,
            "CAS message disagrees with its digest"
        );
        Ok(M::decode(data.as_slice())?)
    }

    pub async fn download(&self, digest: &Digest, file: &mut File) -> Result<()> {
        let mut response = self.get(digest).await?;
        let mut hash = Sha256::new();
        let mut size = 0i64;
        while let Some(chunk) = response.chunk().await? {
            size += chunk.len() as i64;
            ensure!(
                size <= digest.size_bytes,
                "CAS file exceeds its digest size"
            );
            hash.update(&chunk);
            file.write_all(&chunk).await?;
        }
        ensure!(
            size == digest.size_bytes && format!("{:x}", hash.finalize()) == digest.hash,
            "CAS file disagrees with its digest"
        );
        file.flush().await?;
        Ok(())
    }

    async fn upload(&self, digest: &Digest, body: impl Into<reqwest::Body>) -> Result<()> {
        let response = self
            .scheduler
            .client
            .put(self.url(digest)?)
            .bearer_auth(&self.scheduler.token)
            .timeout(Duration::from_secs(120))
            .header("Content-Length", digest.size_bytes)
            .body(body)
            .send()
            .await?;
        ensure!(
            response.status() == StatusCode::NO_CONTENT,
            "CAS upload returned {}",
            response.status()
        );
        Ok(())
    }

    pub async fn upload_bytes(&self, bytes: Vec<u8>) -> Result<Digest> {
        let digest = digest_bytes(&bytes);
        self.upload(&digest, bytes).await?;
        Ok(digest)
    }

    pub async fn upload_file(&self, path: &Path) -> Result<Digest> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = File::open(path).await?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 128 << 10];
        let mut size = 0i64;
        loop {
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            size += read as i64;
            ensure!(size <= 4 << 30, "output file exceeds CAS size limit");
        }
        let digest = Digest {
            hash: format!("{:x}", hash.finalize()),
            size_bytes: size,
        };
        file.rewind().await?;
        self.upload(&digest, reqwest::Body::wrap_stream(ReaderStream::new(file)))
            .await?;
        Ok(digest)
    }
}

pub fn digest_bytes(bytes: &[u8]) -> Digest {
    Digest {
        hash: format!("{:x}", Sha256::digest(bytes)),
        size_bytes: bytes.len() as i64,
    }
}
