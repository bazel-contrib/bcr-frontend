# centrl

## Build Pipeline

```mermaid
graph TB
    subgraph "Data Sources"
        BCR[bazel-central-registry<br/>git submodule]
        GH[GitHub API<br/>Repository Metadata]
    end

    subgraph "Gazelle Extension: //language/bcr"
        BCR --> Parse[Parse Modules]
        Parse --> GenRules[Generate Bazel Rules]
        GenRules --> FetchMeta[Fetch Repository Metadata]
        GH --> FetchMeta
        FetchMeta --> ModMeta[module_metadata rules]
        FetchMeta --> ModVer[module_version rules]
        FetchMeta --> ModReg[module_registry rule]
    end

    subgraph "Documentation Pipeline"
        ModVer --> DownloadArchives[Download http_archive<br/>for latest versions]
        DownloadArchives --> ExtractBzl[Extract .bzl files]
        ExtractBzl --> GenDocs[Generate Documentation<br/>Starlark symbols]
        GenDocs --> DocProto[documentation_registry.pb]
    end

    subgraph "Build Artifacts: //app/bcr:release"
        ModReg --> RegProto[registry.pb<br/>~6MB compressed]
        DocProto --> RegProto
        RegProto --> Embed[Embed into SPA]
        JS[bcr.js<br/>Closure-compiled] --> Embed
        CSS[bcr.css<br/>Styles] --> Embed
        HTML[index.html] --> Embed
        Assets[favicon.png, sitemap.xml, robots.txt] --> Embed
        Embed --> ReleaseTar[release.tar]
    end

    subgraph "Deployment"
        ReleaseTar --> Deploy[cloudflare_deploy<br/>deploy assets]
        Deploy --> Live[https://bcr.stack.build]
    end

    %% Data Sources - Light Blue with darker borders
    style BCR fill:#bbdefb,stroke:#1976d2,stroke-width:2px,color:#000
    style GH fill:#bbdefb,stroke:#1976d2,stroke-width:2px,color:#000

    %% Gazelle Extension - Light Purple
    style Parse fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000
    style GenRules fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000
    style FetchMeta fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000
    style ModMeta fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000
    style ModVer fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000
    style ModReg fill:#e1bee7,stroke:#7b1fa2,stroke-width:2px,color:#000

    %% Documentation Pipeline - Light Orange
    style DownloadArchives fill:#ffccbc,stroke:#e64a19,stroke-width:2px,color:#000
    style ExtractBzl fill:#ffccbc,stroke:#e64a19,stroke-width:2px,color:#000
    style GenDocs fill:#ffccbc,stroke:#e64a19,stroke-width:2px,color:#000
    style DocProto fill:#ffe082,stroke:#f57f17,stroke-width:3px,color:#000

    %% Build Artifacts - Light Green
    style RegProto fill:#ffe082,stroke:#f57f17,stroke-width:3px,color:#000
    style Embed fill:#c5e1a5,stroke:#558b2f,stroke-width:2px,color:#000
    style JS fill:#c5e1a5,stroke:#558b2f,stroke-width:2px,color:#000
    style CSS fill:#c5e1a5,stroke:#558b2f,stroke-width:2px,color:#000
    style HTML fill:#c5e1a5,stroke:#558b2f,stroke-width:2px,color:#000
    style Assets fill:#c5e1a5,stroke:#558b2f,stroke-width:2px,color:#000
    style ReleaseTar fill:#aed581,stroke:#33691e,stroke-width:4px,color:#000

    %% Deployment - Light Teal
    style Deploy fill:#b2dfdb,stroke:#00695c,stroke-width:2px,color:#000
    style Live fill:#80cbc4,stroke:#004d40,stroke-width:4px,color:#000
```

This repository contains:

1. a git submodule `data/bazel-central-registry` pointing to
   `https://github.com/bazelbuild/bazel-central-registry.git`
2. a gazelle extension that runs over `data/bazel-central-registry`:
   1. generates rules foreach module version
   2. fetches github repository metadata
   3. generates a `module_metadata` rule for each `{MODULE_NAME}` under
      `data/bazel-central-registry/modules/{MODULE_NAME}`.
   3. generates a `module_version` rule for each
      `{MODULE_NAME}/{MODULE_VERSION}` under
      `data/bazel-central-registry/modules/{MODULE_NAME}/{MODULE_VERSION}`.
   4. generates a `module_registry` rule at
      `data/bazel-central-registry/modules`.
   5. modifies the root `MODULE.bazel` file with additional http archives (for
      doc generation). 
3. a user interface for the BCR at `//app/bcr`.

To run gazelle:

1. `make bcr_init` to initialize the git submodule.
2. `make bcr_update` to update to the latest version.
3. `make bcr` to run the gazelle extension.  This is equivalent to `GITHUB_TOKEN=XXX bazel run //:bcr`.  You'll need a github api token to fetch necessary metadata from github.  Look the bazel gazelle rule to see various cache files.

To serve the UI:

- `bazel run //app/bcr:release`:
  - downloads a http archive for each latest version (having starlark files).
  - runs a different gazelle extension to collect `.bzl` files.
  - extracts documentation for all latest versions.
  - builds a single `registry.pb` containing the full state of the bazel central
    registry (and docs, this compresses to approx 6MB).
  - embeds that into the single-page application UI.
  - serves it up at :8080.
