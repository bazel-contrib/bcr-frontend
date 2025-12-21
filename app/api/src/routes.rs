use serde::Serialize;
use worker::*;
use prost::Message;

use crate::registry::get_registry;

/// Helper to determine if the client accepts protobuf
fn accepts_protobuf(req: &Request) -> bool {
    req.headers()
        .get("Accept")
        .ok()
        .flatten()
        .map(|accept| accept.contains("application/protobuf") || accept.contains("application/x-protobuf"))
        .unwrap_or(false)
}

/// Helper to create a response based on Accept header
fn create_response<T: Message + Serialize>(req: &Request, data: T) -> Result<Response> {
    if accepts_protobuf(req) {
        // Return protobuf binary
        let mut buf = Vec::new();
        data.encode(&mut buf)
            .map_err(|e| Error::RustError(format!("Failed to encode protobuf: {}", e)))?;

        Response::from_bytes(buf).map(|r| {
            let headers = Headers::new();
            headers.set("Content-Type", "application/protobuf").ok();
            r.with_headers(headers)
        })
    } else {
        // Return JSON (default)
        Response::from_json(&data)
    }
}

#[derive(Serialize)]
struct ModuleListItem {
    name: String,
    latest_version: String,
    description: String,
}

#[derive(Serialize)]
struct RegistryInfo {
    registry_url: String,
    module_count: usize,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Serialize)]
struct VersionInfo {
    version: String,
    build_timestamp: String,
    git_commit: String,
    git_branch: String,
}

/// GET /api/modules
/// Returns list of all modules with basic info
pub async fn handle_modules(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;

    let modules: Vec<ModuleListItem> = registry
        .modules
        .iter()
        .map(|m| ModuleListItem {
            name: m.name.clone(),
            latest_version: m.versions.first().map(|v| v.version.clone()).unwrap_or_default(),
            description: m
                .repository_metadata
                .as_ref()
                .map(|rm| rm.description.clone())
                .unwrap_or_default(),
        })
        .collect();

    Response::from_json(&modules)
}

/// GET /api/modules/:name
/// Returns full module details by name (supports protobuf or JSON)
pub async fn handle_module_by_name(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => create_response(&req, m.clone()),
        None => Ok(Response::from_json(&ErrorResponse {
            error: "Module not found".to_string(),
        })?
        .with_status(404)),
    }
}

/// GET /api/search?q=query
/// Search modules by name or description
pub async fn handle_search(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;

    let url = req.url()?;
    let query = url
        .query_pairs()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.to_lowercase())
        .unwrap_or_default();

    let results: Vec<ModuleListItem> = registry
        .modules
        .iter()
        .filter(|m| {
            m.name.to_lowercase().contains(&query)
                || m.repository_metadata
                    .as_ref()
                    .map(|rm| rm.description.to_lowercase().contains(&query))
                    .unwrap_or(false)
        })
        .take(20)
        .map(|m| ModuleListItem {
            name: m.name.clone(),
            latest_version: m.versions.first().map(|v| v.version.clone()).unwrap_or_default(),
            description: m
                .repository_metadata
                .as_ref()
                .map(|rm| rm.description.clone())
                .unwrap_or_default(),
        })
        .collect();

    Response::from_json(&results)
}

/// GET /api/registry
/// Returns full registry (protobuf) or registry metadata (JSON)
pub async fn handle_registry_info(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;

    if accepts_protobuf(&req) {
        // Return full Registry protobuf
        create_response(&req, registry.clone())
    } else {
        // Return JSON summary
        let info = RegistryInfo {
            registry_url: registry.registry_url.clone(),
            module_count: registry.modules.len(),
        };
        Response::from_json(&info)
    }
}

/// GET /api/version
/// Returns API version information
pub async fn handle_version(_req: Request, _ctx: RouteContext<()>) -> Result<Response> {
    let info = VersionInfo {
        version: option_env!("API_VERSION").unwrap_or("dev").to_string(),
        build_timestamp: option_env!("BUILD_TIMESTAMP").unwrap_or("unknown").to_string(),
        git_commit: option_env!("STABLE_GIT_COMMIT").unwrap_or("unknown").to_string(),
        git_branch: option_env!("STABLE_GIT_BRANCH").unwrap_or("unknown").to_string(),
    };

    Response::from_json(&info)
}
