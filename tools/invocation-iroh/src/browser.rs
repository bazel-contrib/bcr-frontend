use anyhow::{Result, ensure};
use iroh::{
    Endpoint, EndpointAddr, RelayMap, RelayMode,
    endpoint::{Connection, RecvStream, presets},
};
use wasm_bindgen::prelude::*;

use crate::{ALPN, MAX_ATTACHMENT, MAX_SUMMARY, Operation, Request, Ticket};

#[wasm_bindgen]
pub struct InvocationClient {
    endpoint: Endpoint,
    connection: Connection,
    token: String,
}

#[wasm_bindgen]
impl InvocationClient {
    pub async fn dial(ticket: String) -> Result<InvocationClient, JsError> {
        let ticket =
            Ticket::decode(&ticket).map_err(|_| JsError::new("Invalid Iroh viewer ticket."))?;
        ensure_secure_relay(&ticket).map_err(js_error)?;
        let endpoint = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom(RelayMap::from_iter([ticket
                .relay
                .clone()])))
            .bind()
            .await
            .map_err(js_error)?;
        let addr = EndpointAddr::new(ticket.endpoint).with_relay_url(ticket.relay);
        let connection = endpoint.connect(addr, ALPN).await.map_err(js_error)?;
        Ok(Self {
            endpoint,
            connection,
            token: ticket.token,
        })
    }

    pub async fn execution(&self, path: String) -> Result<String, JsError> {
        self.summary(Operation::ExecutionRead { path })
            .await
            .map_err(js_error)
    }

    pub async fn wait_execution_activity(&self, path: String) -> Result<(), JsError> {
        let mut stream = self
            .open(Operation::ExecutionRead { path })
            .await
            .map_err(js_error)?;
        let mut byte = [0; 1];
        stream.read(&mut byte).await.map_err(js_error)?;
        Ok(())
    }

    pub async fn list(&self, token: Option<String>) -> Result<String, JsError> {
        self.summary(token.map_or(Operation::List, |token| Operation::ListPage { token }))
            .await
            .map_err(js_error)
    }

    pub async fn list_groups(&self) -> Result<String, JsError> {
        self.summary(Operation::ListGroups).await.map_err(js_error)
    }

    pub async fn list_group(&self, name: String, token: Option<String>) -> Result<String, JsError> {
        self.summary(Operation::ListGroup { name, token })
            .await
            .map_err(js_error)
    }

    pub async fn group_metrics(&self, name: String, days: Option<u32>) -> Result<String, JsError> {
        self.summary(Operation::GroupMetrics { name, days })
            .await
            .map_err(js_error)
    }

    pub async fn get(&self, id: String) -> Result<String, JsError> {
        self.summary(Operation::Get { id }).await.map_err(js_error)
    }

    pub async fn attachment(&self, id: String, kind: String) -> Result<Vec<u8>, JsError> {
        let mut stream = self
            .open(Operation::Attachment { id, kind })
            .await
            .map_err(js_error)?;
        stream.read_to_end(MAX_ATTACHMENT).await.map_err(js_error)
    }

    pub async fn watch(&self, id: String, after: String) -> Result<InvocationStream, JsError> {
        let stream = self
            .open(Operation::Watch {
                id,
                after: after.parse()?,
            })
            .await
            .map_err(js_error)?;
        Ok(InvocationStream { stream })
    }

    pub async fn close(&self) {
        self.connection.close(0u32.into(), b"viewer closed");
        self.endpoint.close().await;
    }
}

impl InvocationClient {
    async fn open(&self, operation: Operation) -> Result<RecvStream> {
        let (mut send, mut recv) = self.connection.open_bi().await?;
        let request = Request {
            token: self.token.clone(),
            operation,
        };
        send.write_all(&serde_json::to_vec(&request)?).await?;
        send.finish()?;
        let mut status = [0; 2];
        recv.read_exact(&mut status).await?;
        let status = u16::from_be_bytes(status);
        ensure!(status == 200, "invocation backend returned HTTP {status}");
        Ok(recv)
    }

    async fn summary(&self, operation: Operation) -> Result<String> {
        let mut stream = self.open(operation).await?;
        Ok(String::from_utf8(stream.read_to_end(MAX_SUMMARY).await?)?)
    }
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn ensure_secure_relay(ticket: &Ticket) -> Result<()> {
    let relay = &ticket.relay;
    ensure!(
        relay.scheme() == "https"
            || (relay.scheme() == "http"
                && matches!(relay.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
        "expected an HTTPS relay URL"
    );
    Ok(())
}

#[wasm_bindgen]
pub struct InvocationStream {
    stream: RecvStream,
}

#[wasm_bindgen]
impl InvocationStream {
    pub async fn read(&mut self) -> Result<Option<Vec<u8>>, JsError> {
        let mut data = vec![0; 32 * 1024];
        match self.stream.read(&mut data).await? {
            Some(size) => {
                data.truncate(size);
                Ok(Some(data))
            }
            None => Ok(None),
        }
    }
}
