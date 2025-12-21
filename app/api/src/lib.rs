use worker::*;

mod registry;
mod routes;

use routes::{handle_modules, handle_module_by_name, handle_module_version, handle_module_latest, handle_search, handle_registry_info, handle_version};

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Enable CORS
    let cors = Cors::default()
        .with_origins(vec!["*"])
        .with_methods(vec![Method::Get]);

    Router::new()
        .get_async("/api/v1/modules", handle_modules)
        .get_async("/api/v1/modules/:name", handle_module_by_name)
        .get_async("/api/v1/modules/:name/latest", handle_module_latest)
        .get_async("/api/v1/modules/:name/:version", handle_module_version)
        .get_async("/api/v1/search", handle_search)
        .get_async("/api/v1/registry", handle_registry_info)
        .get_async("/api/v1/version", handle_version)
        .run(req, env)
        .await?
        .with_cors(&cors)
}
