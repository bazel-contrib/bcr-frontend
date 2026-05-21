"""RouteInfo helpers — factories for the structs aggregated by rules that emit
SPA routes (module_version, module_metadata, module_registry) and consumed by
the sitemapindexcompiler.

The provider itself is defined in providers.bzl so it can be loaded without
pulling in this helper file; this module only provides the `route(...)` /
`route_info(...)` factories.
"""

load("//rules:providers.bzl", "RouteInfo")

def route(loc, lastmod = "", priority = 0.0, changefreq = ""):
    """Constructs a single route record.

    Args:
        loc: required URL or path. Paths starting with '/' are resolved against
            the registry's base URL at sitemap-compile time.
        lastmod: ISO 8601 date string ('YYYY-MM-DD'). Empty omits the field.
        priority: float in [0, 1]. 0.0 omits the field.
        changefreq: one of 'always'/'hourly'/'daily'/'weekly'/'monthly'/
            'yearly'/'never'. Empty omits the field.

    Returns:
        A struct suitable for storage in a RouteInfo depset.
    """
    return struct(
        loc = loc,
        lastmod = lastmod,
        priority = priority,
        changefreq = changefreq,
    )

def route_info(own = [], transitive = []):
    """Constructs a RouteInfo from own + transitive sub-provider routes.

    Args:
        own: list of struct routes built by `route(...)` directly attached to
            this target.
        transitive: list of RouteInfo providers from depended-on targets whose
            routes should propagate upward (each provider's `routes` depset is
            unioned).

    Returns:
        A RouteInfo provider with a single transitive depset.
    """
    return RouteInfo(
        routes = depset(
            direct = own,
            transitive = [ri.routes for ri in transitive],
        ),
    )
