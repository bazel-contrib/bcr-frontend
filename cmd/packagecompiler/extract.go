package main

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazel-contrib/bcr-frontend/pkg/stardoc"
)

func extractModuleVersionPackages(cfg *config, packageFileByPath map[string]*packageFile, filesToExtract []string) (*sympb.ModuleVersionPackages, error) {
	result := &sympb.ModuleVersionPackages{
		Source: sympb.SymbolSource_BEST_EFFORT,
	}

	var errors int
	for _, filePath := range filesToExtract {
		pkgFile, found := packageFileByPath[filePath]
		if !found {
			return nil, fmt.Errorf("file not found: %q (was it also included as a --package_file?)", filePath)
		}

		pkg, err := extractPackage(cfg, pkgFile)
		if err != nil {
			if cfg.ErrorLimit > 0 && errors > cfg.ErrorLimit {
				cfg.Logger.Panicf("🔴 failed to extract %+v: %v", pkgFile, err)
			} else {
				cfg.Logger.Printf("🔴 failed to extract %+v: %v", pkgFile, err)
			}
			errors++
			// Preserve a stub entry so the registry-side aggregation still has
			// something to attribute to this file (mirrors bzlcompiler's
			// behavior of appending a sympb.File with .Error set).
			result.Package = append(result.Package, &slpb.Package{
				Filename: filePath,
				Error:    []string{err.Error()},
			})
			continue
		}
		result.Package = append(result.Package, pkg)
	}

	total := len(cfg.FilesToExtract)
	success := total - errors
	pct := float64(success) / float64(total) * 100.0
	cfg.Logger.Printf("Extraction: %d/%d %.1f%%", success, total, pct)

	return result, nil
}

func extractPackage(cfg *config, file *packageFile) (*slpb.Package, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	targetFileLabel := stardoc.LabelFromProto(file.Label).String()

	response, err := cfg.Client.PackageInfo(ctx, &slpb.PackageInfoRequest{
		TargetFileLabel: targetFileLabel,
		Rel:             file.Label.Pkg,
		BuiltinsBzlPath: filepath.Join(cfg.Cwd, workDir, "external/_builtins/src/main/starlark/builtins_bzl"),
		DepRoots: []string{
			filepath.Join(cfg.Cwd, workDir),
		},
	})
	if err != nil {
		cleanErr := cleanErrorMessage(err, cfg.Cwd)
		return nil, fmt.Errorf("PackageInfo request error: %v", cleanErr)
	}

	return response, nil
}
