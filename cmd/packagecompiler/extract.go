package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazel-contrib/bcr-frontend/pkg/stardoc"
)

var errConstellateUnavailable = errors.New("constellate server unavailable")

func isConnectionError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "connection refused") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "connect: no route to host") ||
		(strings.Contains(s, "dial tcp") && strings.Contains(s, "connect:"))
}

func extractModuleVersionPackages(cfg *config, packageFileByPath map[string]*packageFile, filesToExtract []string) (*sympb.ModuleVersionPackages, error) {
	result := &sympb.ModuleVersionPackages{
		Source: sympb.SymbolSource_BEST_EFFORT,
	}

	var errCount int
	for _, filePath := range filesToExtract {
		pkgFile, found := packageFileByPath[filePath]
		if !found {
			return nil, fmt.Errorf("file not found: %q (was it also included as a --package_file?)", filePath)
		}

		pkg, err := extractPackage(cfg, pkgFile)
		if err != nil {
			if errors.Is(err, errConstellateUnavailable) {
				return nil, err
			}
			if cfg.ErrorLimit > 0 && errCount > cfg.ErrorLimit {
				cfg.Logger.Panicf("🔴 failed to extract %+v: %v", pkgFile, err)
			} else {
				cfg.Logger.Printf("🔴 failed to extract %+v: %v", pkgFile, err)
			}
			errCount++
			result.Package = append(result.Package, &slpb.Package{
				Filename: filePath,
				Error:    []string{err.Error()},
			})
			continue
		}
		result.Package = append(result.Package, pkg)
	}

	total := len(cfg.FilesToExtract)
	success := total - errCount
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
		if isConnectionError(err) {
			return nil, fmt.Errorf("%w: %v", errConstellateUnavailable, cleanErr)
		}
		return nil, fmt.Errorf("PackageInfo request error: %v", cleanErr)
	}

	return response, nil
}
