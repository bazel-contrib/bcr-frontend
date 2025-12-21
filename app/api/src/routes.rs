use serde::Serialize;
use worker::*;
use prost::Message;

use crate::registry::get_registry;

// Badge styling options
#[derive(Debug, Clone)]
struct BadgeStyle {
    style: String,
    color: String,
    label: String,
}

impl Default for BadgeStyle {
    fn default() -> Self {
        Self {
            style: "flat".to_string(),
            color: "44cc11".to_string(), // Success green
            label: "bcr".to_string(),
        }
    }
}

impl BadgeStyle {
    fn from_query(url: &Url) -> Self {
        let mut style = BadgeStyle::default();

        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "style" => style.style = value.to_string(),
                "color" => style.color = Self::parse_color(value.as_ref()),
                "label" => style.label = value.to_string(),
                _ => {}
            }
        }

        style
    }

    fn parse_color(color: &str) -> String {
        // Handle shields.io named colors
        match color {
            "brightgreen" => "44cc11".to_string(),
            "green" => "97ca00".to_string(),
            "yellowgreen" => "a4a61d".to_string(),
            "yellow" => "dfb317".to_string(),
            "orange" => "fe7d37".to_string(),
            "red" => "e05d44".to_string(),
            "blue" => "007ec6".to_string(),
            "lightgrey" => "9f9f9f".to_string(),
            "success" => "44cc11".to_string(),
            "important" => "fe7d37".to_string(),
            "critical" => "e05d44".to_string(),
            "informational" => "007ec6".to_string(),
            _ => {
                // If it's already hex-like, use it; otherwise default
                if color.chars().all(|c| c.is_ascii_hexdigit()) {
                    color.to_string()
                } else {
                    "007ec6".to_string()
                }
            }
        }
    }
}

/// Generate SVG badge
fn generate_badge_svg(label: &str, message: &str, style: &BadgeStyle) -> String {
    // Calculate approximate text widths (rough estimate: 6px per character)
    let label_width = (label.len() as f32 * 6.0 + 10.0) as u32;
    let message_width = (message.len() as f32 * 6.0 + 10.0) as u32;
    let total_width = label_width + message_width;

    let label_center = label_width / 2;
    let message_center = label_width + (message_width / 2);

    match style.style.as_str() {
        "flat-square" => {
            format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"20\" role=\"img\" aria-label=\"{}: {}\"><title>{}: {}</title><g><rect width=\"{}\" height=\"20\" fill=\"#555\"/><rect x=\"{}\" width=\"{}\" height=\"20\" fill=\"#{}\"/></g><g fill=\"#fff\" text-anchor=\"middle\" font-family=\"Verdana,Geneva,DejaVu Sans,sans-serif\" font-size=\"11\"><text x=\"{}\" y=\"14\">{}</text><text x=\"{}\" y=\"14\">{}</text></g></svg>",
                total_width, label, message, label, message,
                label_width, label_width, message_width, style.color,
                label_center, label, message_center, message
            )
        }
        _ => {
            // Default "flat" style with rounded corners
            format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"20\" role=\"img\" aria-label=\"{}: {}\"><title>{}: {}</title><linearGradient id=\"s\" x2=\"0\" y2=\"100%\"><stop offset=\"0\" stop-color=\"#bbb\" stop-opacity=\".1\"/><stop offset=\"1\" stop-opacity=\".1\"/></linearGradient><clipPath id=\"r\"><rect width=\"{}\" height=\"20\" rx=\"3\" fill=\"#fff\"/></clipPath><g clip-path=\"url(#r)\"><rect width=\"{}\" height=\"20\" fill=\"#555\"/><rect x=\"{}\" width=\"{}\" height=\"20\" fill=\"#{}\"/><rect width=\"{}\" height=\"20\" fill=\"url(#s)\"/></g><g fill=\"#fff\" text-anchor=\"middle\" font-family=\"Verdana,Geneva,DejaVu Sans,sans-serif\" font-size=\"11\"><text x=\"{}\" y=\"15\" fill=\"#010101\" fill-opacity=\".3\">{}</text><text x=\"{}\" y=\"14\">{}</text><text x=\"{}\" y=\"15\" fill=\"#010101\" fill-opacity=\".3\">{}</text><text x=\"{}\" y=\"14\">{}</text></g></svg>",
                total_width, label, message, label, message,
                total_width,
                label_width, label_width, message_width, style.color, total_width,
                label_center, label, label_center, label,
                message_center, message, message_center, message
            )
        }
    }
}

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

/// GET /api/v1alpha1/modules
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

/// GET /api/v1alpha1/modules/:name
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

/// GET /api/v1alpha1/modules/:name/latest
/// Returns the latest version of a module (supports protobuf or JSON)
pub async fn handle_module_latest(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => {
            // Latest version is typically the first in the array
            match m.versions.first() {
                Some(mv) => create_response(&req, mv.clone()),
                None => Ok(Response::from_json(&ErrorResponse {
                    error: "No versions found for module".to_string(),
                })?
                .with_status(404)),
            }
        }
        None => Ok(Response::from_json(&ErrorResponse {
            error: "Module not found".to_string(),
        })?
        .with_status(404)),
    }
}

/// GET /api/v1alpha1/modules/:name/:version
/// Returns specific module version (supports protobuf or JSON)
pub async fn handle_module_version(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");
    let version = ctx.param("version").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => {
            let module_version = m.versions.iter().find(|v| v.version == version);
            match module_version {
                Some(mv) => create_response(&req, mv.clone()),
                None => Ok(Response::from_json(&ErrorResponse {
                    error: "Module version not found".to_string(),
                })?
                .with_status(404)),
            }
        }
        None => Ok(Response::from_json(&ErrorResponse {
            error: "Module not found".to_string(),
        })?
        .with_status(404)),
    }
}

/// GET /api/v1alpha1/search?q=query
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

/// GET /api/v1alpha1/registry
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

/// GET /api/v1alpha1/version
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_badge_style_default() {
        let style = BadgeStyle::default();
        assert_eq!(style.label, "bcr");
        assert_eq!(style.color, "44cc11"); // Success green
        assert_eq!(style.style, "flat");
    }

    #[test]
    fn test_badge_style_parse_color_named() {
        assert_eq!(BadgeStyle::parse_color("brightgreen"), "44cc11");
        assert_eq!(BadgeStyle::parse_color("success"), "44cc11");
        assert_eq!(BadgeStyle::parse_color("red"), "e05d44");
        assert_eq!(BadgeStyle::parse_color("blue"), "007ec6");
        assert_eq!(BadgeStyle::parse_color("critical"), "e05d44");
    }

    #[test]
    fn test_badge_style_parse_color_hex() {
        assert_eq!(BadgeStyle::parse_color("5c5"), "5c5");
        assert_eq!(BadgeStyle::parse_color("007ec6"), "007ec6");
        assert_eq!(BadgeStyle::parse_color("invalid"), "007ec6"); // Falls back to blue
    }

    #[test]
    fn test_generate_badge_svg_flat() {
        let style = BadgeStyle {
            style: "flat".to_string(),
            color: "44cc11".to_string(),
            label: "bcr".to_string(),
        };
        let svg = generate_badge_svg("bcr", "1.0.0", &style);

        assert!(svg.contains("<svg"));
        assert!(svg.contains("bcr"));
        assert!(svg.contains("1.0.0"));
        assert!(svg.contains("#44cc11"));
        assert!(svg.contains("linearGradient")); // Flat style has gradient
    }

    #[test]
    fn test_generate_badge_svg_flat_square() {
        let style = BadgeStyle {
            style: "flat-square".to_string(),
            color: "e05d44".to_string(),
            label: "test".to_string(),
        };
        let svg = generate_badge_svg("test", "error", &style);

        assert!(svg.contains("<svg"));
        assert!(svg.contains("test"));
        assert!(svg.contains("error"));
        assert!(svg.contains("#e05d44"));
        assert!(!svg.contains("linearGradient")); // Flat-square has no gradient
    }

    #[test]
    fn test_generate_badge_svg_width_calculation() {
        let style = BadgeStyle::default();

        // Short text
        let svg_short = generate_badge_svg("a", "b", &style);

        // Long text
        let svg_long = generate_badge_svg("bazel-central-registry", "1.2.3", &style);

        // Extract width from SVG (rough check)
        assert!(svg_long.len() > svg_short.len());
    }
}

/// GET /api/v1alpha1/modules/:name/badge.svg
/// Returns SVG badge for the latest version of a module
pub async fn handle_module_badge(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => {
            match m.versions.first() {
                Some(mv) => {
                    let url = req.url()?;
                    let badge_style = BadgeStyle::from_query(&url);
                    let svg = generate_badge_svg(&badge_style.label, &mv.version, &badge_style);

                    let headers = Headers::new();
                    headers.set("Content-Type", "image/svg+xml")?;
                    headers.set("Cache-Control", "public, max-age=300")?; // 5 minutes for latest

                    Ok(Response::ok(svg)?.with_headers(headers))
                }
                None => {
                    // Return "not found" badge
                    let svg = generate_badge_svg("bcr", "no versions", &BadgeStyle {
                        color: "e05d44".to_string(),
                        ..BadgeStyle::default()
                    });

                    let headers = Headers::new();
                    headers.set("Content-Type", "image/svg+xml")?;
                    headers.set("Cache-Control", "public, max-age=60")?;

                    Ok(Response::ok(svg)?.with_headers(headers))
                }
            }
        }
        None => {
            // Return "not found" badge
            let svg = generate_badge_svg("bcr", "not found", &BadgeStyle {
                color: "e05d44".to_string(),
                ..BadgeStyle::default()
            });

            let headers = Headers::new();
            headers.set("Content-Type", "image/svg+xml")?;
            headers.set("Cache-Control", "public, max-age=60")?;

            Ok(Response::ok(svg)?.with_headers(headers))
        }
    }
}

/// GET /api/v1alpha1/modules/:name/:version/badge.svg
/// Returns SVG badge for a specific version of a module
pub async fn handle_module_version_badge(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let registry = get_registry(&ctx.env).await?;
    let module_name = ctx.param("name").map(|s| s.as_str()).unwrap_or("");
    let version = ctx.param("version").map(|s| s.as_str()).unwrap_or("");

    let module = registry.modules.iter().find(|m| m.name == module_name);

    match module {
        Some(m) => {
            let module_version = m.versions.iter().find(|v| v.version == version);
            match module_version {
                Some(mv) => {
                    let url = req.url()?;
                    let badge_style = BadgeStyle::from_query(&url);
                    let svg = generate_badge_svg(&badge_style.label, &mv.version, &badge_style);

                    let headers = Headers::new();
                    headers.set("Content-Type", "image/svg+xml")?;
                    headers.set("Cache-Control", "public, max-age=86400")?; // 1 day for specific versions

                    Ok(Response::ok(svg)?.with_headers(headers))
                }
                None => {
                    // Return "not found" badge
                    let svg = generate_badge_svg("bcr", "version not found", &BadgeStyle {
                        color: "e05d44".to_string(),
                        ..BadgeStyle::default()
                    });

                    let headers = Headers::new();
                    headers.set("Content-Type", "image/svg+xml")?;
                    headers.set("Cache-Control", "public, max-age=60")?;

                    Ok(Response::ok(svg)?.with_headers(headers))
                }
            }
        }
        None => {
            // Return "not found" badge
            let svg = generate_badge_svg("bcr", "module not found", &BadgeStyle {
                color: "e05d44".to_string(),
                ..BadgeStyle::default()
            });

            let headers = Headers::new();
            headers.set("Content-Type", "image/svg+xml")?;
            headers.set("Cache-Control", "public, max-age=60")?;

            Ok(Response::ok(svg)?.with_headers(headers))
        }
    }
}
