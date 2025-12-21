use worker::*;

mod registry;
mod routes;

use routes::{handle_modules, handle_module_by_name, handle_search, handle_registry_info, handle_version};

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Enable CORS
    let cors = Cors::default()
        .with_origins(vec!["*"])
        .with_methods(vec![Method::Get]);

    Router::new()
        .get_async("/api/modules", handle_modules)
        .get_async("/api/modules/:name", handle_module_by_name)
        .get_async("/api/search", handle_search)
        .get_async("/api/registry", handle_registry_info)
        .get_async("/api/version", handle_version)
        .run(req, env)
        .await?
        .with_cors(&cors)
}
