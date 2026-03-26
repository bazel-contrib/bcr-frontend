"provides the ghpages_deploy rule"

def _ghpages_deploy_impl(ctx):
    content = """#!/usr/bin/env bash
set -euo pipefail

# DEPLOY_REMOTE: e.g. https://x-access-token:TOKEN@github.com/bazel-contrib/bcr-frontend-site.git
if [ -z "${{DEPLOY_REMOTE:-}}" ]; then
  echo "Error: DEPLOY_REMOTE environment variable not set"
  exit 1
fi

TARBALL=$(cd "$(dirname "{tarball}")" && pwd)/$(basename "{tarball}")
WORKDIR=$(mktemp -d)
trap "rm -rf $WORKDIR" EXIT

# Clone existing repo to reuse git object cache (reduces push transfer size).
# If the branch doesn't exist yet, fall back to git init.
if git ls-remote --exit-code "$DEPLOY_REMOTE" main >/dev/null 2>&1; then
  git clone --depth=1 --branch=main "$DEPLOY_REMOTE" "$WORKDIR"
  # Remove all tracked files but keep .git and preserved dirs
  cd "$WORKDIR"
  git rm -rf --quiet . >/dev/null 2>&1 || true
  git checkout HEAD -- modules/ CNAME 2>/dev/null || true
else
  cd "$WORKDIR"
  git init
  git checkout -b main
  git remote add origin "$DEPLOY_REMOTE"
fi

# Extract fresh SPA assets from release.tar (overwrites matching files)
tar -xf "$TARBALL" -C "$WORKDIR"

# Copy index.html to 404.html for SPA client-side routing
cp "$WORKDIR/index.html" "$WORKDIR/404.html"

# Commit and force push
git add .
git commit -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push --force origin main
""".format(
        tarball = ctx.file.tarball.short_path,
    )

    ctx.actions.write(
        output = ctx.outputs.executable,
        content = content,
        is_executable = True,
    )

    return [
        DefaultInfo(
            files = depset([ctx.outputs.executable]),
            runfiles = ctx.runfiles(files = [ctx.file.tarball]),
        ),
    ]

ghpages_deploy = rule(
    implementation = _ghpages_deploy_impl,
    attrs = {
        "tarball": attr.label(
            mandatory = True,
            allow_single_file = [".tar"],
        ),
    },
    executable = True,
)
