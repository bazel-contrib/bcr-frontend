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
        "name": "The module name",
        "homepage": "Homepage URL for the module",
        "maintainers": "List of maintainer targets providing ModuleMaintainerInfo",
        "repository": "List of repository URLs",
        "repository_metadata": "the RepositoryMetadataInfo provider",
        "versions": "List of version strings",
        "yanked_versions": "Dictionary mapping version to reason for yanking",
        "deprecated": "Deprecation message if deprecated",
        "deps": "List of module version targets providing ModuleVersionInfo",
        "metadata_json": "The metadata.json file",
        "proto": "The compiled Module proto file",
        "build_bazel": "The BUILD.bazel file",
    },
)

ModuleDependencyInfo = provider(
    doc = "Info about a Module Dependency",
    fields = {
        "name": "Dependency module name",
        "version": "Dependency module version",
        "dev": "Whether this is a dev dependency",
        "unresolved": "Whether this is an unresolved dependency",
        "module": "Module version target providing ModuleVersionInfo",
        "cycle": "Cycle target providing ModuleDependencyCycleInfo if this dependency is part of a cycle",
        "override": "Override target providing ModuleOverrideInfo",
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
        "source_json": "The source.json file",
    },
)

ModuleAttestationsInfo = provider(
    doc = "Info about Module Attestations",
    fields = {
        "media_type": "Media type for the attestations file",
        "urls": "Map of file names to attestation URLs",
        "integrities": "Map of file names to attestation integrity hashes",
        "attestations_json": "The attestations.json file",
    },
)

ModuleVersionInfo = provider(
    doc = "Info about a Module Version",
    fields = {
        "name": "Module name",
        "version": "Module version",
        "compatibility_level": "Module compatibility level",
        "bazel_compatibility": "List of compatible Bazel versions",
        "repo_name": "Repository name",
        "deps": "List of dependency targets providing ModuleDependencyInfo",
        "source": "Source target providing ModuleSourceInfo",
        "attestations": "Attestations target providing ModuleAttestationsInfo",
        "presubmit": "Presubmit target providing ModulePresubmitInfo",
        "commit": "Commit target providing ModuleCommitInfo",
        "module_bazel": "The MODULE.bazel file",
        "build_bazel": "The BUILD.bazel file",
        "proto": "The compiled ModuleVersion proto file",
    },
)

ModulePresubmitInfo = provider(
    doc = "Info about Module Presubmit Configuration",
    fields = {
        "presubmit_yml": "The presubmit.yml file",
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
        "cycles": "List of module dep cycle targets providing ModuleDependencyCycleInfo",
        "proto": "The compiled Registry proto file",
        "repository_url": "Repository URL of the registry (e.g. 'https://github.com/bazelbuild/bazel-central-registry')",
        "registry_url": "URL of the registry UI (e.g. 'https://registry.bazel.build')",
        "branch": "Branch name of the repository data (e.g. 'main')",
        "commit": "Commit sha1 of the repository data",
        "commit_date": "Timestamp of the commit date (ISO 8601 format)",
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
        "remote": "Git remote URL",
        "branch": "Git branch name",
        "patch_strip": "Number of path components to strip from patches",
        "patches": "List of patch files",
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

RepositoryMetadataInfo = provider(
    doc = "Info about a Repository Metadata",
    fields = {
        "type": "Repository type (e.g., 'GITHUB')",
        "canonical_name": "Repository canonical name",
        "json_file": "The emitted json file",
        "organization": "Organization or owner name",
        "repo_name": "Repository name",
        "description": "Repository description",
        "stargazers": "Number of stargazers",
        "languages": "Map of programming languages to line counts",
        "primary_language": "primary language name based on counts",
    },
)

ModuleCommitInfo = provider(
    doc = "Info about a Module Commit",
    fields = {
        "sha1": "Git commit SHA-1 hash",
        "date": "Commit date in ISO 8601 format",
        "message": "Commit message",
    },
)
