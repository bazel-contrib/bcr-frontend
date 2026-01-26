# bcr-frontend

This repository provides a web UI and API for the [Bazel Central Registry](https://github.com/bazelbuild/bazel-central-registry).

- A git submodule is located at `data/bazel-central-registry`.
- A custom gazelle extension `//language/bcr` walks the module tree under `data/bazel-central-registry/modules`, creating a set of build rules that represent the state of the registry.  The various modules and module versions are linked into a top-level `module_registry rule //data/bazel-central-registry/modules:modules`.  A makefile target `make bcr` can be run locally that checks out the most recent version of the submodule and runs the gazelle extension.
  - NOTE: `GITHUB_TOKEN` is required for fetching repository metadata during a
    gazelle run.
- A protobuf representation of the state of the BCR is constructed by `bazel build //data/bazel-central-registry/modules:modules`.  This includes downloading source repository archives for latest versions (that include starlark files) and extracting stardoc for them, outputting the file `bazel-bin/data/bazel-central-registry/modules/registry.pb`.
- `bazel run //app/bcr:release` builds the frontend single-page-application UI
  and embed the registry proto data in it, and starts a webserver for local development.
- `bazel //app/api` builds a rust->wasm app that runs as a cloudflare worker to service API requests.  The UI does not currently depend on the API; the primary purpose is to support shields.io-like badges (example: ![bazek-skylib-latest](https://bcr.stack.build/api/v1alpha1/modules/bazel_skylib/badge.svg?label=bazel_skylib)).  The API also serves fragments of the `Registry` protobuf data.
- `bazel run //app/bcr:deploy` builds the UI and API and deploys it to cloudflare.

CI works as follows:

- [ ] When new commits land in `github.com/bazelbuild/bazel-central-registry`, a
  repository dispatch triggers the `update-bcr-submodule` job, which creates a
  new PR that updates the submodule commit and labels the PR with
  `bcr-auto-update`.
- [x] A cron job (triggers every 30m) also calls `update-bcr-submodule`.  This
  will be disabled once repository dispatch is setup.
- [x] The `deploy-and-merge-bcr-pr` runs gazelle on the submodule, builds and deploys an updated version to cloudflare.  A successful PR of this type is auto-merged.

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

## Maintenance and Support

This repo is funded by contributions to our
[OpenCollective](https://opencollective.com/bazel-rules-authors-sig/projects/bazel-central-registry).
Maintenance is performed on a best-effort basis by volunteers in the Bazel
community.

## Contributing

We are happy about any contributions!

To get started you can take a look at our [Github
issues](https://github.com/bazel-contrib/bcr-frontend/issues).

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be
licensed as below, without any additional terms or conditions.

## Quick Start

Have a `GITHUB_TOKEN` available (for rate limit increases):

```sh
$ export GITHUB_TOKEN=ghp_...
```

Step 1: initialize (or update) the bcr submodule:

```sh
$ make bcr_init
$ make bcr_update
```

Step 2: run the gazelle extension over it (with GITHUB_TOKEN):

```sh
$ bazel run bcr
```

Step 3: build and run a development server over the release assets (consider `ibazel` for iterative development):

```sh
$ bazel run //app/bcr:release
...
releaseserver: Starting server on http://localhost:8080
releaseserver: Press Ctrl+C to stop
```
