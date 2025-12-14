"""Providers for Bazel Central Registry (BCR) metadata and module information."""

ModuleMaintainerInfo = provider(
    doc = "Information about a module maintainer.",
    fields = {
        "do_not_notify": "bool: Whether to suppress notifications to this maintainer",
        "email": "str: Maintainer email address",
        "github_user_id": "int: GitHub user ID",
        "github": "str: GitHub username",
        "username": "str: Maintainer username",
    },
)

ModuleMetadataInfo = provider(
    doc = "Metadata about a Bazel module.",
    fields = {
        "name": "str: Module name",
        "homepage": "str: Homepage URL for the module",
        "maintainers": "depset[ModuleMaintainerInfo]: Maintainers providing ModuleMaintainerInfo",
        "repository": "list[str]: Repository URLs",
        "repository_metadata": "RepositoryMetadataInfo | None: Repository metadata provider",
        "versions": "list[str]: Module version strings",
        "yanked_versions": "dict[str, str]: Mapping of yanked version to reason",
        "deprecated": "str: Deprecation message (empty string if not deprecated)",
        "deps": "List[ModuleVersionInfo]: Module version providers",
        "metadata_json": "File: The metadata.json file",
        "proto": "File: The compiled Module protobuf file",
        "build_bazel": "File | None: The BUILD.bazel file",
    },
)

ModuleDependencyInfo = provider(
    doc = "Information about a module dependency relationship.",
    fields = {
        "name": "str: Dependency module name",
        "version": "str: Dependency module version",
        "repo_name": "str: Effective repository name for the dependency",
        "dev": "bool: Whether this is a dev dependency",
        "unresolved": "bool: Whether this dependency failed to resolve",
        "module": "ModuleVersionInfo | None: Module version provider",
        "transitive_modules": "depset[ModuleDependencyInfo]: All transitive dependencies (not currently set)",
        "cycle": "ModuleDependencyCycleInfo | None: Cycle provider if part of a dependency cycle",
        "override": "ModuleOverrideInfo | None: Override provider if overridden",
    },
)

ModuleSourceInfo = provider(
    doc = "Source archive information for a module version.",
    fields = {
        "url": "str: Source archive URL",
        "url_status_code": "int: HTTP status code of the source URL",
        "url_status_message": "str: HTTP status message of the source URL",
        "integrity": "str: Source integrity hash (e.g., sha256-...)",
        "strip_prefix": "str: Directory prefix to strip from the archive",
        "patch_strip": "int: Number of leading path components to strip from patches",
        "patches": "dict[str, str]: Mapping of patch filename to integrity hash",
        "source_json": "File: The source.json file",
        "docs_url": "str: Documentation archive URL (empty string if not set)",
        "docs_url_status_code": "int: HTTP status code of the docs URL",
        "docs_url_status_message": "str: HTTP status message of the docs URL",
        "commit_sha": "str: Git commit SHA for the source URL (resolved from tags/releases)",
    },
)

ModuleAttestationsInfo = provider(
    doc = "Attestation information for a module version.",
    fields = {
        "media_type": "str: Media type for the attestations file",
        "urls": "dict[str, str]: Mapping of filename to attestation URL",
        "integrities": "dict[str, str]: Mapping of filename to attestation integrity hash",
        "attestations_json": "File: The attestations.json file",
    },
)

ModuleVersionInfo = provider(
    doc = "Complete information about a specific module version.",
    fields = {
        "id": "str: a unique key like 'bazel_skylib@1.8.2'",
        "name": "str: Module name",
        "version": "str: Module version",
        "is_latest_version": "bool: if this is the latest module version",
        "compatibility_level": "int: Module compatibility level",
        "bazel_compatibility": "list[str]: Compatible Bazel version ranges",
        "repo_name": "str: Repository name",
        "deps": "list[ModuleDependencyInfo]: Direct dependency providers",
        "source": "ModuleSourceInfo: Source provider",
        "attestations": "ModuleAttestationsInfo | None: Attestations provider",
        "presubmit": "ModulePresubmitInfo | None: Presubmit provider",
        "commit": "ModuleCommitInfo | None: Commit provider",
        "module_bazel": "File | None: The MODULE.bazel file",
        "build_bazel": "File | None: The BUILD.bazel file",
        "proto": "File: The compiled ModuleVersion protobuf file",
        "published_docs": "list[File]: Published documentation files from http_archive",
        "bzl_src": "StarlarkModuleLibraryInfo | None: .bzl source files for the current module version",
        "bzl_deps": "List[StarlarkModuleLibraryInfo]]: List of .bzl source file dependencies",
    },
)

ModulePresubmitInfo = provider(
    doc = "Presubmit configuration for a module version.",
    fields = {
        "presubmit_yml": "File: The presubmit.yml configuration file",
    },
)

ModuleDependencyCycleInfo = provider(
    doc = "Information about a dependency cycle in the module graph.",
    fields = {
        "modules": "list[str]: Module version strings that form the cycle",
        "cycle_name": "str: Unique identifier for this cycle",
    },
)

ModuleRegistryInfo = provider(
    doc = "Information about the Bazel Central Registry.",
    fields = {
        "deps": "depset[ModuleMetadataInfo]: Module metadata providers",
        "cycles": "depset[ModuleDependencyCycleInfo]: Dependency cycle providers",
        "proto": "File: The compiled Registry protobuf file",
        "repository_url": "str: Git repository URL (e.g., 'https://github.com/bazelbuild/bazel-central-registry')",
        "registry_url": "str: Registry UI URL (e.g., 'https://registry.bazel.build')",
        "branch": "str: Git branch name (e.g., 'main')",
        "commit": "str: Git commit SHA-1 hash",
        "commit_date": "str: Commit timestamp in ISO 8601 format",
    },
)

ModuleOverrideInfo = provider(
    doc = "Base information for a module override.",
    fields = {
        "module_name": "str: Name of the module being overridden",
    },
)

GitOverrideInfo = provider(
    doc = "Git-based module override configuration.",
    fields = {
        "module_name": "str: Name of the module being overridden",
        "commit": "str: Git commit hash",
        "remote": "str: Git remote URL",
        "branch": "str: Git branch name",
        "patch_strip": "int: Number of leading path components to strip from patches",
        "patches": "list[str]: Patch file paths",
    },
)

ArchiveOverrideInfo = provider(
    doc = "Archive-based module override configuration.",
    fields = {
        "module_name": "str: Name of the module being overridden",
        "integrity": "str: Archive integrity hash",
        "patch_strip": "int: Number of leading path components to strip from patches",
        "patches": "list[str]: Patch file paths",
        "strip_prefix": "str: Directory prefix to strip from the archive",
        "urls": "list[str]: Archive URLs",
    },
)

SingleVersionOverrideInfo = provider(
    doc = "Single-version module override configuration.",
    fields = {
        "module_name": "str: Name of the module being overridden",
        "patch_strip": "int: Number of leading path components to strip from patches",
        "patches": "list[str]: Patch file paths",
        "version": "str: Specific version to use",
    },
)

LocalPathOverrideInfo = provider(
    doc = "Local filesystem path module override configuration.",
    fields = {
        "module_name": "str: Name of the module being overridden",
        "path": "str: Local filesystem path to the module",
    },
)

RepositoryMetadataInfo = provider(
    doc = "Metadata about a source code repository (e.g., GitHub, GitLab).",
    fields = {
        "type": "str: Repository type (e.g., 'github', 'gitlab')",
        "canonical_name": "str: Canonical repository name (e.g., 'github:org/repo')",
        "json_file": "File: The emitted JSON metadata file",
        "organization": "str: Organization or owner name",
        "repo_name": "str: Repository name",
        "description": "str: Repository description",
        "stargazers": "int: Number of stars/stargazers",
        "languages": "dict[str, str]: Mapping of programming language to line count (as string)",
        "primary_language": "str: Primary language based on line counts",
    },
)

ModuleCommitInfo = provider(
    doc = "Git commit information for a module version.",
    fields = {
        "sha1": "str: Git commit SHA-1 hash",
        "date": "str: Commit date in ISO 8601 format",
        "message": "str: Git commit message",
    },
)

BazelVersionInfo = provider(
    doc = "Information about a specific Bazel release version.",
    fields = {
        "version": "str: Bazel version (e.g., '7.0.0', '8.0.0-pre.20241128.3')",
        "bazel_help": "File: the output file for compilation of bazel help text",
    },
)
