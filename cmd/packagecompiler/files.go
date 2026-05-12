package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/buildtools/build"
	"google.golang.org/grpc/status"
)

func preparePackageFiles(cfg *config) (map[string]*packageFile, error) {
	packageFileByPath := make(map[string]*packageFile)

	for _, file := range cfg.PackageFiles {
		packageFileByPath[file.Path] = file
		if err := rewritePackageFile(cfg, file); err != nil {
			return nil, err
		}
	}

	return packageFileByPath, nil
}

// prepareShimBzlFiles are special-case stand-ins for non-module dependencies
// that BUILD files (and the .bzl files they load) may reach for.  Kept in sync
// with bzlcompiler/files.go.
func prepareShimBzlFiles(cfg *config) {
	mustWriteWorkDirFile(cfg, "external/host_platform/constraints.bzl", "HOST_CONSTRAINTS = []")
	mustWriteWorkDirFile(cfg, "external/bazel_features_version/version.bzl", "version = '8.4.2'")
	mustWriteWorkDirFile(cfg, "external/bazel_features_globals/globals.bzl", bazel_features_globals_globals_bzl)
	mustWriteWorkDirFile(cfg, "external/bazel_tools/tools/cpp/lib_cc_configure.bzl", lib_cc_configure_bzl)
	mustWriteWorkDirFile(cfg, "external/rules_java/java/java_binary.bzl", java_binary_bzl)
	mustWriteWorkDirFile(cfg, "external/compatibility_proxy/proxy.bzl", java_compatibility_proxy_bzl)
	mustWriteWorkDirFile(cfg, "external/cc_compatibility_proxy/proxy.bzl", cc_compatibility_proxy_bzl)
	mustWriteWorkDirFile(cfg, "external/cc_compatibility_proxy/symbols.bzl", cc_compatibility_symbols_bzl)
}

func rewritePackageFile(cfg *config, file *packageFile) error {
	deps, found := cfg.moduleDeps[file.RepoName]
	if !found {
		cfg.Logger.Printf("WARN: dependencies for %s not found", file.RepoName)
	}

	srcPath := filepath.Join(cfg.Cwd, file.Path)
	if _, err := os.Stat(srcPath); os.IsNotExist(err) {
		listFiles(cfg.Logger, cfg.Cwd)
		return fmt.Errorf("rewritePackageFile: source file %s not found in %s", file.Path, cfg.Cwd)
	}

	ast, loads, data, err := readPackageFile(cfg, srcPath)
	if err != nil {
		return err
	}

	for _, load := range loads {
		from, err := label.Parse(load.Module.Value)
		if err != nil {
			return fmt.Errorf("failed to parse label %s in package %s: %v", load.Module.Value, file.Path, err)
		}
		to := from.Abs(file.RepoName, file.Label.Pkg)

		switch from.Repo {
		case "":
			to.Repo = sanitizeRepoName(file.RepoName)
		case file.RepoName:
			to.Repo = sanitizeRepoName(file.RepoName)
		case "bazel_tools":
			to.Repo = "bazel_tools"
		case "_builtins":
			to.Repo = "_builtins"
		default:
			var match *bzpb.ModuleDependency
			for _, dep := range deps {
				if dep.RepoName == from.Repo {
					to.Repo = dep.Name
					match = dep
				} else if dep.Name == from.Repo {
					to.Repo = dep.Name
					match = dep
				}
			}
			if match == nil {
				if debugSandbox {
					cfg.Logger.Printf("WARN: unknown dependency @%s of module %s (%s)", from.Repo, file.RepoName, file.Path)
				}
			}
		}
		if from != to {
			load.Module.Value = to.String()
			if debugSandbox {
				cfg.Logger.Printf("rewrote load: %s --> %s", from, to)
			}
		}
	}

	if ast != nil {
		data = build.Format(ast)
	}

	workingPath := filepath.Join(workDir, "external", file.Label.Repo, file.Label.Pkg, file.Label.Name)
	dstPath := filepath.Join(cfg.Cwd, workingPath)

	return writeFile(dstPath, data, os.ModePerm)
}

// readPackageFile parses a .package (renamed BUILD) file using ParseBuild so
// the AST understands native rule calls at the top level, not just .bzl-style
// definitions.
func readPackageFile(cfg *config, path string) (*build.File, []*build.LoadStmt, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("os.ReadFile(%q) error: %v", path, err)
	}
	ast, err := build.ParseBuild(path, data)
	if err != nil {
		if failOnParseErrors {
			return nil, nil, nil, fmt.Errorf("build.ParseBuild(%q) error: %v", data, err)
		}
		cfg.Logger.Printf("WARN: build.ParseBuild(%q) error: %v", path, err)
	}
	if ast == nil {
		return ast, nil, data, nil
	}

	var loads []*build.LoadStmt
	build.WalkOnce(ast, func(expr *build.Expr) {
		n := *expr
		if l, ok := n.(*build.LoadStmt); ok {
			loads = append(loads, l)
		}
	})

	return ast, loads, data, nil
}

func mustWriteWorkDirFile(cfg *config, relPath string, content string) {
	if err := writeFile(
		filepath.Join(cfg.Cwd, workDir, relPath),
		[]byte(content),
		os.ModePerm,
	); err != nil {
		log.Panicf("writing file to the workdir: %v", err)
	}
}

func writeFile(dst string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, mode)
}

func listFiles(logger *log.Logger, dir string) error {
	logger.Println("Listing files under " + dir)
	return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			logger.Printf("%v\n", err)
			return err
		}
		logger.Println(path)
		return nil
	})
}

func cleanErrorMessage(err error, cwd string) error {
	if err == nil {
		return nil
	}

	if s, ok := status.FromError(err); ok {
		err = fmt.Errorf("%s", s.Message())
	}

	msg := err.Error()
	prefix := filepath.Join(cwd, workDir) + string(filepath.Separator)
	cleanMsg := strings.ReplaceAll(msg, prefix, "")
	return fmt.Errorf("%s", cleanMsg)
}

func sanitizeRepoName(name string) string {
	return strings.ReplaceAll(name, "~", "+")
}

// Shim file contents lifted from bzlcompiler/files.go.  Kept in sync so the
// starlarkserver sees the same baseline environment for both ModuleInfo and
// PackageInfo evaluations.

const java_binary_bzl = `
"""Test for direct native rule forwarding without load statements."""

def java_binary(**attrs):
    """Bazel java_binary rule.

    https://docs.bazel.build/versions/master/be/java.html#java_binary

    Args:
      **attrs: Rule attributes
    """
    native.java_binary(**attrs)
`

const cc_compatibility_proxy_bzl = `
load("@rules_cc//cc/private/rules_impl:cc_binary.bzl", _cc_binary = "cc_binary")
load("@rules_cc//cc/private/rules_impl:cc_import.bzl", _cc_import = "cc_import")
load("@rules_cc//cc/private/rules_impl:cc_library.bzl", _cc_library = "cc_library")
load("@rules_cc//cc/private/rules_impl:cc_shared_library.bzl", _cc_shared_library = "cc_shared_library")
load("@rules_cc//cc/private/rules_impl:cc_static_library.bzl", _cc_static_library = "cc_static_library")
load("@rules_cc//cc/private/rules_impl:cc_test.bzl", _cc_test = "cc_test")
load("@rules_cc//cc/private/rules_impl:objc_import.bzl", _objc_import = "objc_import")
load("@rules_cc//cc/private/rules_impl:objc_library.bzl", _objc_library = "objc_library")
load("@rules_cc//cc/private/rules_impl/fdo:fdo_prefetch_hints.bzl", _fdo_prefetch_hints = "fdo_prefetch_hints")
load("@rules_cc//cc/private/rules_impl/fdo:fdo_profile.bzl", _fdo_profile = "fdo_profile")
load("@rules_cc//cc/private/rules_impl/fdo:memprof_profile.bzl", _memprof_profile = "memprof_profile")
load("@rules_cc//cc/private/rules_impl/fdo:propeller_optimize.bzl", _propeller_optimize = "propeller_optimize")
load("@rules_cc//cc/private/rules_impl:cc_toolchain.bzl", _cc_toolchain = "cc_toolchain")
load("@rules_cc//cc/private/rules_impl:cc_toolchain_alias.bzl", _cc_toolchain_alias = "cc_toolchain_alias")

cc_binary = _cc_binary
cc_import = _cc_import
cc_library = _cc_library
cc_shared_library = _cc_shared_library
cc_static_library = _cc_static_library
cc_test = _cc_test
objc_import = _objc_import
objc_library = _objc_library
fdo_prefetch_hints = _fdo_prefetch_hints
fdo_profile = _fdo_profile
memprof_profile = _memprof_profile
propeller_optimize = _propeller_optimize
cc_toolchain = _cc_toolchain
cc_toolchain_alias = _cc_toolchain_alias
`

const cc_compatibility_symbols_bzl = `
load("@rules_cc//cc/private:cc_common.bzl", _cc_common = "cc_common")
load("@rules_cc//cc/private:cc_info.bzl", _CcInfo = "CcInfo")
load("@rules_cc//cc/private:cc_shared_library_info.bzl", _CcSharedLibraryInfo = "CcSharedLibraryInfo")
load("@rules_cc//cc/private:debug_package_info.bzl", _DebugPackageInfo = "DebugPackageInfo")
load("@rules_cc//cc/private:objc_info.bzl", _ObjcInfo = "ObjcInfo")
load("@rules_cc//cc/private/toolchain_config:cc_toolchain_config_info.bzl", _CcToolchainConfigInfo = "CcToolchainConfigInfo")

cc_common = _cc_common
CcInfo = _CcInfo
DebugPackageInfo = _DebugPackageInfo
CcToolchainConfigInfo = _CcToolchainConfigInfo
ObjcInfo = _ObjcInfo
new_objc_provider = _ObjcInfo
CcSharedLibraryInfo = _CcSharedLibraryInfo
`

const java_compatibility_proxy_bzl = `
load("@rules_java//java/bazel/rules:bazel_java_binary_wrapper.bzl", _java_binary = "java_binary")
load("@rules_java//java/bazel/rules:bazel_java_import.bzl", _java_import = "java_import")
load("@rules_java//java/bazel/rules:bazel_java_library.bzl", _java_library = "java_library")
load("@rules_java//java/bazel/rules:bazel_java_plugin.bzl", _java_plugin = "java_plugin")
load("@rules_java//java/bazel/rules:bazel_java_test.bzl", _java_test = "java_test")
load("@rules_java//java/bazel:http_jar.bzl", _http_jar = "http_jar")
load("@rules_java//java/common/rules:java_package_configuration.bzl", _java_package_configuration = "java_package_configuration")
load("@rules_java//java/common/rules:java_runtime.bzl", _java_runtime = "java_runtime")
load("@rules_java//java/common/rules:java_toolchain.bzl", _java_toolchain = "java_toolchain")
load("@rules_java//java/private:java_common.bzl", _java_common = "java_common")
load("@rules_java//java/private:java_common_internal.bzl", _java_common_internal_compile = "compile")
load("@rules_java//java/private:java_info.bzl", _JavaInfo = "JavaInfo", _JavaPluginInfo = "JavaPluginInfo", _java_info_internal_merge = "merge", _java_info_to_implicit_exportable = "to_implicit_exportable")

java_binary = _java_binary
java_import = _java_import
java_library = _java_library
java_plugin = _java_plugin
java_test = _java_test
java_package_configuration = _java_package_configuration
java_runtime = _java_runtime
java_toolchain = _java_toolchain
java_common = _java_common
JavaInfo = _JavaInfo
JavaPluginInfo = _JavaPluginInfo
java_common_internal_compile = _java_common_internal_compile
java_info_internal_merge = _java_info_internal_merge
java_info_to_implicit_exportable = _java_info_to_implicit_exportable
http_jar = _http_jar
`

const bazel_features_globals_globals_bzl = `
globals = struct(
    CcSharedLibraryInfo = CcSharedLibraryInfo,
    CcSharedLibraryHintInfo = CcSharedLibraryHintInfo,
    macro = macro,
    PackageSpecificationInfo = PackageSpecificationInfo,
    RunEnvironmentInfo = RunEnvironmentInfo,
    subrule = subrule,
    DefaultInfo = DefaultInfo,
    __TestingOnly_NeverAvailable = None,
    JavaInfo = getattr(getattr(native, 'legacy_globals', None), 'JavaInfo', None),
    JavaPluginInfo = getattr(getattr(native, 'legacy_globals', None), 'JavaPluginInfo', None),
    ProtoInfo = getattr(getattr(native, 'legacy_globals', None), 'ProtoInfo', None),
    PyCcLinkParamsProvider = getattr(getattr(native, 'legacy_globals', None), 'PyCcLinkParamsProvider', None),
    PyInfo = getattr(getattr(native, 'legacy_globals', None), 'PyInfo', None),
    PyRuntimeInfo = getattr(getattr(native, 'legacy_globals', None), 'PyRuntimeInfo', None),
    cc_proto_aspect = getattr(getattr(native, 'legacy_globals', None), 'cc_proto_aspect', None),
)
`

const lib_cc_configure_bzl = `
# pylint: disable=g-bad-file-header
# Copyright 2016 The Bazel Authors. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Base library for configuring the C++ toolchain."""

def resolve_labels(repository_ctx, labels):
    """Resolves a collection of labels to their paths."""
    return dict([(label, repository_ctx.path(Label(label))) for label in labels])

def escape_string(arg):
    """Escape percent sign (%) in the string so it can appear in the Crosstool."""
    if arg != None:
        return str(arg).replace("%", "%%")
    else:
        return None

def split_escaped(string, delimiter):
    if delimiter == "":
        fail("Delimiter cannot be empty")
    if delimiter.find("%") != -1:
        fail("Delimiter cannot contain %-sign")

    i = 0
    result = []
    accumulator = []
    length = len(string)
    delimiter_length = len(delimiter)

    if not string:
        return []

    for _ in range(length):
        if i >= length:
            break
        if i + 2 <= length and string[i:i + 2] == "%%":
            accumulator.append("%")
            i += 2
        elif (i + 1 + delimiter_length <= length and
              string[i:i + 1 + delimiter_length] == "%" + delimiter):
            accumulator.append(delimiter)
            i += 1 + delimiter_length
        elif i + delimiter_length <= length and string[i:i + delimiter_length] == delimiter:
            result.append("".join(accumulator))
            accumulator = []
            i += delimiter_length
        else:
            accumulator.append(string[i])
            i += 1

    result.append("".join(accumulator))
    return result

def auto_configure_fail(msg):
    red = "\033[0;31m"
    no_color = "\033[0m"
    fail("\n%sAuto-Configuration Error:%s %s\n" % (red, no_color, msg))

def auto_configure_warning(msg):
    yellow = "\033[1;33m"
    no_color = "\033[0m"
    print("\n%sAuto-Configuration Warning:%s %s\n" % (yellow, no_color, msg))

def get_env_var(repository_ctx, name, default = None, enable_warning = True):
    if name in repository_ctx.os.environ:
        return repository_ctx.os.environ[name]
    if default != None:
        if enable_warning:
            auto_configure_warning("'%s' environment variable is not set, using '%s' as default" % (name, default))
        return default
    auto_configure_fail("'%s' environment variable is not set" % name)

def which(repository_ctx, cmd, default = None):
    result = repository_ctx.which(cmd)
    return default if result == None else str(result)

def which_cmd(repository_ctx, cmd, default = None):
    result = repository_ctx.which(cmd)
    if result != None:
        return str(result)
    path = get_env_var(repository_ctx, "PATH")
    if default != None:
        auto_configure_warning("Cannot find %s in PATH, using '%s' as default.\nPATH=%s" % (cmd, default, path))
        return default
    auto_configure_fail("Cannot find %s in PATH, please make sure %s is installed and add its directory in PATH.\nPATH=%s" % (cmd, cmd, path))
    return str(result)

def execute(
        repository_ctx,
        command,
        environment = None,
        expect_failure = False,
        expect_empty_output = False):
    if environment:
        result = repository_ctx.execute(command, environment = environment)
    else:
        result = repository_ctx.execute(command)
    if expect_failure != (result.return_code != 0):
        if expect_failure:
            auto_configure_fail(
                "expected failure, command %s, stderr: (%s)" % (
                    command,
                    result.stderr,
                ),
            )
        else:
            auto_configure_fail(
                "non-zero exit code: %d, command %s, stderr: (%s)" % (
                    result.return_code,
                    command,
                    result.stderr,
                ),
            )
    stripped_stdout = result.stdout.strip()
    if expect_empty_output != (not stripped_stdout):
        if expect_empty_output:
            auto_configure_fail(
                "non-empty output from command %s, stdout: (%s), stderr: (%s)" % (command, result.stdout, result.stderr),
            )
        else:
            auto_configure_fail(
                "empty output from command %s, stderr: (%s)" % (command, result.stderr),
            )
    return stripped_stdout

def get_cpu_value(repository_ctx):
    os_name = repository_ctx.os.name
    arch = repository_ctx.os.arch
    if os_name.startswith("mac os"):
        return "darwin_" + ("arm64" if arch == "aarch64" else "x86_64")
    if os_name.find("freebsd") != -1:
        return "freebsd"
    if os_name.find("openbsd") != -1:
        return "openbsd"
    if os_name.find("windows") != -1:
        if arch == "aarch64":
            return "arm64_windows"
        else:
            return "x64_windows"

    if arch in ["power", "ppc64le", "ppc", "ppc64"]:
        return "ppc"
    if arch in ["s390x"]:
        return "s390x"
    if arch in ["mips64"]:
        return "mips64"
    if arch in ["riscv64"]:
        return "riscv64"
    if arch in ["arm", "armv7l"]:
        return "arm"
    if arch in ["aarch64"]:
        return "aarch64"
    return "k8" if arch in ["amd64", "x86_64", "x64"] else "piii"

def is_cc_configure_debug(repository_ctx):
    env = repository_ctx.os.environ
    return "CC_CONFIGURE_DEBUG" in env and env["CC_CONFIGURE_DEBUG"] == "1"

def build_flags(flags):
    return "\n".join(["        flag: '" + flag + "'" for flag in flags])

def get_starlark_list(values):
    if not values:
        return ""
    return "\"" + "\",\n    \"".join(values) + "\""

def auto_configure_warning_maybe(repository_ctx, msg):
    if is_cc_configure_debug(repository_ctx):
        auto_configure_warning(msg)

def write_builtin_include_directory_paths(repository_ctx, cc, directories, file_suffix = ""):
    if get_env_var(repository_ctx, "BAZEL_IGNORE_SYSTEM_HEADERS_VERSIONS", "0", False) == "1":
        repository_ctx.file(
            "builtin_include_directory_paths" + file_suffix,
            """This file is generated by cc_configure and normally contains builtin include directories
that C++ compiler reported. But because BAZEL_IGNORE_SYSTEM_HEADERS_VERSIONS was set to 1,
header include directory paths are intentionally not put there.
""",
        )
    else:
        repository_ctx.file(
            "builtin_include_directory_paths" + file_suffix,
            """This file is generated by cc_configure and contains builtin include directories
that %s reported. This file is a dependency of every compilation action and
changes to it will be reflected in the action cache key. When some of these
paths change, Bazel will make sure to rerun the action, even though none of
declared action inputs or the action commandline changes.

%s
""" % (cc, "\n".join(directories)),
        )
`
