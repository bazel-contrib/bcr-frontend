use prost::Message;
use worker::*;

// Import the generated protobuf types
use bzpb_rs::build::stack::bazel::bzlmod::v1::Registry;

static mut CACHED_REGISTRY: Option<Registry> = None;

/// Lazy-load and cache the registry protobuf
#[allow(static_mut_refs)]
pub async fn get_registry(env: &Env) -> Result<&'static Registry> {
    unsafe {
        if CACHED_REGISTRY.is_none() {
            let registry = load_registry(env).await?;
            CACHED_REGISTRY = Some(registry);
        }
        Ok(CACHED_REGISTRY.as_ref().unwrap())
    }
}

/// Load registry.pb from ASSETS binding
async fn load_registry(env: &Env) -> Result<Registry> {
    // Get the ASSETS binding as a Fetcher
    let assets = env.get_binding::<Fetcher>("ASSETS")
        .map_err(|e| Error::RustError(format!("Failed to get ASSETS binding: {}", e)))?;

    // Fetch registrylite.pb from assets (need dummy URL per worker-rs docs)
    // registrylite.pb is an uncompressed, smaller version that fits within Cloudflare's 25MB asset limit
    let url = "https://example.com/registrylite.pb";
    let mut response = assets.fetch(url, None).await?;

    if response.status_code() != 200 {
        return Err(Error::RustError(format!(
            "Failed to fetch registrylite.pb: status {}",
            response.status_code()
        )));
    }

    // Get the response body bytes and parse directly (no decompression needed)
    let body_bytes = response.bytes().await?;

    Registry::decode(&body_bytes[..])
        .map_err(|e| Error::RustError(format!("Failed to decode registry: {}", e)))
}
