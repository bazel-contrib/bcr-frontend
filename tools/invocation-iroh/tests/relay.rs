// An isolated relay for the browser integration test.
use std::net::Ipv4Addr;

use anyhow::Result;
use iroh_relay::server::{RelayConfig, Server, ServerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, 0)));
    let relay = Server::spawn(config).await?;
    println!("Relay URL: http://{}", relay.http_addr().unwrap());
    tokio::signal::ctrl_c().await?;
    Ok(())
}
