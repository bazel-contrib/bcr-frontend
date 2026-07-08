# Bazel Central Registry targets
.PHONY: bcr_init
bcr_init:
	git submodule update --init data/bazel-central-registry
	git -C data/bazel-central-registry rev-parse --git-dir >/dev/null 2>&1 || { echo "data/bazel-central-registry is not an initialized git repo; aborting to avoid corrupting the parent repo's sparse-checkout"; exit 1; }
	git -C data/bazel-central-registry sparse-checkout init --no-cone
	git -C data/bazel-central-registry sparse-checkout set modules
	git -C data/bazel-central-registry fetch --unshallow || true

.PHONY: bcr_update
bcr_update:
	git submodule update --remote data/bazel-central-registry

.PHONY: bcr_clean
bcr_clean:
	git -C data/bazel-central-registry rev-parse --git-dir >/dev/null 2>&1 || { echo "data/bazel-central-registry is not an initialized git repo; run 'make bcr_init' first"; exit 1; }
	git -C data/bazel-central-registry reset --hard && git -C data/bazel-central-registry clean -fd
	git -C data/bazel-central-registry sparse-checkout init --no-cone
	git -C data/bazel-central-registry sparse-checkout set modules

.PHONY: bcr
bcr: bcr_clean bcr_update
	bazel run bcr

# Code generation targets
.PHONY: regenerate_protos
regenerate_protos:
	bazel run //:proto_assets

.PHONY: regenerate_octicons
regenerate_octicons:
	bazel run //app/bcr:octicons

# Server targets
.PHONY: serve
serve:
	bazel run //app/bcr:release

.PHONY: serve-production
serve-production:
	bazel run //app/bcr:release --//app/bcr:release_type=production

# Deployment targets
.PHONY: deploy
deploy:
	bazel run //app/bcr:deploy --//app/bcr:release_type=production

.PHONY: deploy-ghpages
deploy-ghpages:
	bazel run //app/bcr:ghpages --//app/bcr:release_type=production

# Rust/Cargo targets
.PHONY: cargo_update_lockfile
cargo_update_lockfile:
	cargo update --manifest-path app/api/Cargo.toml

# Example: generate documentation for a single module version
.PHONY: build_docs_for_module_version
build_docs_for_module_version:
	bazel build //data/bazel-central-registry/modules --output_groups=rules_go-0.59.0
