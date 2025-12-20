use serde::Serialize;
use worker::*;

use crate::registry::get_registry;

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

/// GET /api/modules
/// Returns list of all modules with basic info
pub async fn handle_modules(req: Request, _ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&req).await?;

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
/// Returns full module details by name
pub async fn handle_module_by_name(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&req).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => Response::from_json(m),
        None => Ok(Response::from_json(&ErrorResponse {
            error: "Module not found".to_string(),
        })?
        .with_status(404)),
    }
}

/// GET /api/search?q=query
/// Search modules by name or description
pub async fn handle_search(req: Request, _ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&req).await?;

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
/// Returns registry metadata
pub async fn handle_registry_info(req: Request, _ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&req).await?;

    let info = RegistryInfo {
        registry_url: registry.registry_url.clone(),
        module_count: registry.modules.len(),
    };

    Response::from_json(&info)
}
