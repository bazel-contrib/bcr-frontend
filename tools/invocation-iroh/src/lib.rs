use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use iroh::{EndpointId, RelayUrl};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"bcr/invocation-viewer/1";
pub const MAX_REQUEST: usize = 1024;
pub const MAX_SUMMARY: usize = 16 * 1024 * 1024;
const TICKET_PREFIX: &str = "bcr-iroh-v1:";

#[cfg(target_arch = "wasm32")]
mod browser;

/// The credential is scoped and checked by the companion on every request.
#[derive(Serialize, Deserialize)]
pub struct Ticket {
    pub endpoint: EndpointId,
    pub relay: RelayUrl,
    pub token: String,
}

impl Ticket {
    pub fn encode(&self) -> Result<String> {
        Ok(format!(
            "{TICKET_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }

    pub fn decode(encoded: &str) -> Result<Self> {
        ensure!(encoded.len() <= 4096, "connection ticket is too long");
        let payload = encoded
            .trim()
            .strip_prefix(TICKET_PREFIX)
            .context("invalid connection ticket")?;
        Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?)?)
    }
}

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub token: String,
    pub operation: Operation,
}

#[derive(Serialize, Deserialize)]
pub enum Operation {
    List,
    ListGroups,
    ListGroup { name: String },
    GroupMetrics { name: String },
    Get { id: String },
    Watch { id: String, after: u64 },
}

pub fn valid_group_name(name: &str) -> bool {
    name.len() <= 128
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

pub fn valid_invocation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
