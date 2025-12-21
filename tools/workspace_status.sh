#!/bin/bash
# Workspace status script for Bazel stamping
# This script outputs stable and volatile status variables

# Stable values (these don't change unless the git state changes)
echo STABLE_GIT_COMMIT $(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo STABLE_GIT_BRANCH $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Volatile values (these change every build)
echo BUILD_TIMESTAMP $(date -u +%Y-%m-%dT%H:%M:%SZ)
echo BUILD_HOST $(hostname)
echo BUILD_USER ${USER}

# Version info
echo BUILD_API_VERSION 0.1.1
