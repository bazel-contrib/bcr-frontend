"provides the ghpages_deploy rule"

def _ghpages_deploy_impl(ctx):
    content = """#!/usr/bin/env bash
set -euo pipefail

# DEPLOY_REMOTE: e.g. https://x-access-token:TOKEN@github.com/bazel-contrib/bcr-frontend-site.git
if [ -z "${{DEPLOY_REMOTE:-}}" ]; then
  echo "Error: DEPLOY_REMOTE environment variable not set"
  exit 1
fi

WORKDIR=$(mktemp -d)
trap "rm -rf $WORKDIR" EXIT

# Fetch existing content from main (if branch exists)
if git ls-remote --exit-code "$DEPLOY_REMOTE" main >/dev/null 2>&1; then
  git clone --depth=1 --branch=main "$DEPLOY_REMOTE" "$WORKDIR/old"
  # Preserve modules/ directory (accumulated per-version docs)
  if [ -d "$WORKDIR/old/modules" ]; then
    mv "$WORKDIR/old/modules" "$WORKDIR/modules"
  fi
  # Preserve CNAME file (GitHub Pages custom domain config)
  if [ -f "$WORKDIR/old/CNAME" ]; then
    mv "$WORKDIR/old/CNAME" "$WORKDIR/CNAME"
  fi
  rm -rf "$WORKDIR/old"
fi

# Extract fresh SPA assets from release.tar
tar -xf {tarball} -C "$WORKDIR"

# Copy index.html to 404.html for SPA client-side routing
cp "$WORKDIR/index.html" "$WORKDIR/404.html"

# Create orphan commit and force push
cd "$WORKDIR"
git init
git checkout -b main
git add .
git commit -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git remote add origin "$DEPLOY_REMOTE"
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
