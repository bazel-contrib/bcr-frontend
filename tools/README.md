# Binary Tools

This directory provides convenient aliases for running protocol buffer code generation tools as standalone binaries.

## Available Tools

### protoc-gen-tonic

Generate Rust gRPC server/client code using Tonic.

```bash
# Check version
bazel run //tools:protoc-gen-tonic -- --version

# Use in custom script
bazel run //tools:protoc-gen-tonic -- \
  --proto_path=. \
  --tonic_out=generated \
  myproto.proto
```

### protoc-gen-prost

Generate Rust message types using Prost.

```bash
# Check help
bazel run //tools:protoc-gen-prost -- --help

# Use in custom script
bazel run //tools:protoc-gen-prost -- \
  --proto_path=. \
  --prost_out=generated \
  myproto.proto
```

## Usage in Proto Rules

These tools are also available as proto_plugin targets:

```starlark
load("@build_stack_rules_proto//rules:proto_compile.bzl", "proto_compile")

proto_compile(
    name = "my_proto_rust",
    outputs = ["my.rs"],
    plugins = [
        "//bazel_tools/rust:protoc-gen-prost",
        "//bazel_tools/rust:protoc-gen-tonic",
    ],
    proto = ":my_proto",
)
```

## Implementation

The binary aliases are defined in:
- `//tools:BUILD.bazel` - User-facing aliases
- `//bazel_tools/rust:BUILD.bazel` - Actual tool targets from `@rules_rust` crate registry
