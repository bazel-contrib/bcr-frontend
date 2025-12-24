# Cloudflare Pages Direct Upload

This package provides Go bindings for the Cloudflare Pages API, allowing you to deploy to Cloudflare Pages without using Wrangler.

## Features

- ✅ Direct upload to Cloudflare Pages via API
- ✅ No Node.js or npm dependencies required
- ✅ Create and manage projects programmatically
- ✅ List and inspect deployments
- ✅ Upload from tar archives
- ✅ Environment variable configuration

## Installation

```bash
go get github.com/bazel-contrib/bcr-frontend/pkg/cf
```

## Usage

### As a Library

```go
package main

import (
    "log"
    "github.com/bazel-contrib/bcr-frontend/pkg/cf"
)

func main() {
    // Create a client
    client := cf.NewClient("your-api-token", "your-account-id")

    // Get or create a project
    project, err := client.GetProject("my-site")
    if err != nil {
        project, err = client.CreateProject("my-site", "main")
        if err != nil {
            log.Fatal(err)
        }
    }

    // Upload a deployment from a tarball
    deployment, err := client.UploadDeployment("my-site", "dist.tar")
    if err != nil {
        log.Fatal(err)
    }

    log.Printf("Deployed to: %s", deployment.URL)
}
```

### As a CLI Tool

Build and use the `cfdeploy` command:

```bash
# Build the tool
bazel build //cmd/cfdeploy

# Set up authentication
export CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
export CF_ACCOUNT_ID=your-cloudflare-account-id

# Deploy
bazel-bin/cmd/cfdeploy/cfdeploy_/cfdeploy \
  --project=my-site \
  --tarball=dist.tar
```

## Getting Cloudflare Credentials

### API Token

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template or create a custom token with:
   - Permissions: `Account.Cloudflare Pages: Edit`
   - Account Resources: Include your account

### Account ID

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your account
3. Find "Account ID" in the right sidebar
4. Copy the ID

## API Reference

### Client

```go
client := cf.NewClient(apiToken, accountID)
```

### Projects

```go
// Get a project
project, err := client.GetProject("project-name")

// Create a project
project, err := client.CreateProject("project-name", "production-branch")
```

### Deployments

```go
// Upload from tarball
deployment, err := client.UploadDeployment("project-name", "path/to/tarball.tar")

// Get deployment info
deployment, err := client.GetDeployment("project-name", "deployment-id")

// List all deployments
deployments, err := client.ListDeployments("project-name")
```

## Tarball Format

The tarball should contain your static site files at the root level:

```
tarball.tar
├── index.html
├── app.js
├── styles.css
└── assets/
    └── logo.png
```

You can create this with the `releasecompiler` tool:

```bash
bazel run //cmd/releasecompiler -- \
  --output_file=release.tar \
  --index_html_file=index.html \
  app.js styles.css assets/logo.png
```

## Integration with Bazel

See `//app/bcr:deploy` for an example of integrating this into a Bazel build rule.

## Why Not Wrangler?

- **Simpler CI/CD**: No Node.js installation required
- **Better Bazel Integration**: Pure Go tool fits better in Bazel workflows
- **Faster**: No npm package installation overhead
- **More Control**: Direct API access for custom workflows

## Limitations

- Currently only supports direct upload (no Git integration)
- Does not support Functions or Workers (static sites only)
- No interactive features (intended for CI/CD use)

## References

- [Cloudflare Pages API Documentation](https://developers.cloudflare.com/api/operations/pages-project-get-project)
- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/platform/direct-upload/)