ModuleMaintainerInfo = provider(
    doc = "Info about a Module Maintainer",
    fields = {
        "email": "Maintainer email address",
        "username": "Maintainer name",
        "github": "GitHub username",
        "do_not_notify": "Whether to not notify this maintainer",
        "github_user_id": "GitHub user ID",
    },
)

ModuleMetadataInfo = provider(
    doc = "Info about a Module Metadata",
    fields = {
        "homepage": "Homepage URL for the module",
        "maintainers": "List of maintainer targets providing ModuleMaintainerInfo",
        "repository": "List of repository URLs",
        "versions": "List of version strings",
        "yanked_versions": "Dictionary mapping version to reason for yanking",
        "deprecated": "Deprecation message if deprecated",
    },
)

ModuleDependencyInfo = provider(
    doc = "Info about a Module Dependency",
    fields = {
        "name": "Dependency module name",
        "version": "Dependency module version",
        "dev": "Whether this is a dev dependency",
    },
)

ModuleSourceInfo = provider(
    doc = "Info about a Module Source",
    fields = {
        "url": "Source archive URL",
        "integrity": "Source integrity hash",
        "strip_prefix": "Directory prefix to strip from archive",
        "patch_strip": "Number of path components to strip from patches",
        "patches": "Map of patch filenames to integrity hashes",
    },
)

ModuleAttestationsInfo = provider(
    doc = "Info about Module Attestations",
    fields = {
        "media_type": "Media type for the attestations file",
        "urls": "Map of file names to attestation URLs",
        "integrities": "Map of file names to attestation integrity hashes",
    },
)

ModuleVersionInfo = provider(
    doc = "Info about a Module Version",
    fields = {
        "name": "Module name",
        "version": "Module version",
        "compatibility_level": "Module compatibility level",
        "repo_name": "Repository name",
        "deps": "List of dependency targets providing ModuleDependencyInfo",
        "source": "Source target providing ModuleSourceInfo",
        "attestations": "Attestations target providing ModuleAttestationsInfo",
    },
)
