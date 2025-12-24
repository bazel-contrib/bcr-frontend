# Bazel Central Registry targets
.PHONY: bcr_init
bcr_init:
	git submodule update --init data/bazel-central-registry
	(cd data/bazel-central-registry && git sparse-checkout set --no-cone modules)

.PHONY: bcr_update
bcr_update:
	git submodule update --remote data/bazel-central-registry

.PHONY: bcr_clean
bcr_clean:
	(cd data/bazel-central-registry && git reset --hard && git clean -fd)
	(cd data/bazel-central-registry && git sparse-checkout set --no-cone modules)

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

# Rust/Cargo targets
.PHONY: cargo_update_lockfile
cargo_update_lockfile:
	cargo update --manifest-path app/api/Cargo.toml

# Example: generate documentation for a single module version
.PHONY: build_docs_for_module_version
build_docs_for_module_version:
	bazel build //data/bazel-central-registry/modules --output_groups=rules_go-0.59.0
