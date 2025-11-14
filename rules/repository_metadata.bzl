"provides the repository_metadata rule"

load("//rules:providers.bzl", "RepositoryMetadataInfo")

def _repository_metadata_impl(ctx):
    return [
        RepositoryMetadataInfo(
            type = ctx.attr.type,
            organization = ctx.attr.organization,
            repo_name = ctx.attr.repo_name,
            description = ctx.attr.description,
            stargazers = ctx.attr.stargazers,
            languages = ctx.attr.languages,
        ),
    ]

repository_metadata = rule(
    implementation = _repository_metadata_impl,
    attrs = {
        "type": attr.string(
            doc = "Repository type (e.g., 'GITHUB', 'REPOSITORY_TYPE_UNKNOWN')",
        ),
        "organization": attr.string(
            doc = "Organization or owner name",
        ),
        "repo_name": attr.string(
            doc = "Repository name",
        ),
        "description": attr.string(
            doc = "Repository description",
        ),
        "stargazers": attr.int(
            doc = "Number of stargazers",
        ),
        "languages": attr.string_dict(
            doc = "Map of programming languages to line counts",
        ),
    },
    provides = [RepositoryMetadataInfo],
)
