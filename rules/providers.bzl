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
        "deps": "List of module version targets providing ModuleVersionInfo",
    },
)

ModuleDependencyInfo = provider(
    doc = "Info about a Module Dependency",
    fields = {
        "name": "Dependency module name",
        "version": "Dependency module version",
        "dev": "Whether this is a dev dependency",
        "module": "Module version target providing ModuleVersionInfo",
        "cycle": "Cycle target providing ModuleDependencyCycleInfo if this dependency is part of a cycle",
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

ModuleDependencyCycleInfo = provider(
    doc = "Info about a Module Dependency Cycle",
    fields = {
        "modules": "List of module version targets in the cycle",
        "cycle_name": "Name identifier for this cycle",
    },
)

ModuleRegistryInfo = provider(
    doc = "Info about a Module Registry",
    fields = {
        "deps": "List of module metadata targets providing ModuleMetadataInfo",
    },
)

ModuleOverrideInfo = provider(
    doc = "Info about a Module Override",
    fields = {
        "module_name": "Name of the module being overridden",
    },
)

GitOverrideInfo = provider(
    doc = "Info about a Git Override",
    fields = {
        "module_name": "Name of the module being overridden",
        "commit": "Git commit hash",
        "patch_strip": "Number of path components to strip from patches",
        "patches": "List of patch files",
        "remote": "Git remote URL",
    },
)

ArchiveOverrideInfo = provider(
    doc = "Info about an Archive Override",
    fields = {
        "module_name": "Name of the module being overridden",
        "integrity": "Integrity hash",
        "patch_strip": "Number of path components to strip from patches",
        "patches": "List of patch files",
        "strip_prefix": "Directory prefix to strip from archive",
        "urls": "List of archive URLs",
    },
)

SingleVersionOverrideInfo = provider(
    doc = "Info about a Single Version Override",
    fields = {
        "module_name": "Name of the module being overridden",
        "patch_strip": "Number of path components to strip from patches",
        "patches": "List of patch files",
        "version": "Version to use",
    },
)

LocalPathOverrideInfo = provider(
    doc = "Info about a Local Path Override",
    fields = {
        "module_name": "Name of the module being overridden",
        "path": "Local filesystem path",
    },
)
