use prost::Message;
use worker::*;

// Import the generated protobuf types
use bzpb_rs::build::stack::bazel::bzlmod::v1::Registry;

static mut CACHED_REGISTRY: Option<Registry> = None;

/// Lazy-load and cache the registry protobuf
pub async fn get_registry(req: &Request) -> Result<&'static Registry> {
    unsafe {
        if CACHED_REGISTRY.is_none() {
            let registry = load_registry(req).await?;
            CACHED_REGISTRY = Some(registry);
        }
        Ok(CACHED_REGISTRY.as_ref().unwrap())
    }
}

/// Load registry.pb.gz from static assets
async fn load_registry(_req: &Request) -> Result<Registry> {
    // Fetch the registry from external URL
    // TODO: Make this configurable via environment variable
    let registry_url = "https://bcr.stack.build/registry.pb.gz";

    // Fetch compressed registry
    let mut init = RequestInit::new();
    init.method = Method::Get;

    let registry_req = Request::new_with_init(&registry_url, &init)?;
    let mut response = Fetch::Request(registry_req).send().await?;
    let compressed_bytes = response.bytes().await?;

    // Decompress using gzip
    let decompressed = decompress_gzip(&compressed_bytes)?;

    // Parse protobuf
    Registry::decode(&decompressed[..])
        .map_err(|e| Error::RustError(format!("Failed to decode registry: {}", e)))
}

/// Simple gzip decompression
fn decompress_gzip(data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|e| Error::RustError(format!("Failed to decompress: {}", e)))?;
    Ok(decompressed)
}
