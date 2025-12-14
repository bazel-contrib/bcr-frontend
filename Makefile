init:
	git submodule update --init data/bazel-central-registry
	(cd data/bazel-central-registry && git sparse-checkout set --no-cone modules)
	
update:
	git submodule update --remote data/bazel-central-registry

clean:
	(cd data/bazel-central-registry && git reset --hard && git clean -fd)
	(cd data/bazel-central-registry && git sparse-checkout set --no-cone modules)

.PHONY: modules
modules:
	bazel run modules

regenerate_protos:
	bazel run //:proto_assets

regenerate_octicons:
	bazel run //app/bcr:octicons

server:
	bazel run //app/bcr:release

devserver:
	bazel run //app/bcr:release --//app/bcr:release_type=debug

deploy:
	bazel run //app/bcr:deploy

build_docs_for_module_version:
	bazel build //data/bazel-central-registry/modules --output_groups=rules_go-0.59.0