package main

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
	"github.com/stackb/centrl/pkg/stardoc"
)

func extractDocumentationInfo(cfg *config, bzlFileByPath map[string]*bzlFile, filesToExtract []string) (*bzpb.DocumentationInfo, error) {
	result := &bzpb.DocumentationInfo{
		Source: bzpb.DocumentationSource_BEST_EFFORT,
	}

	var errors int
	for _, filePath := range filesToExtract {
		bzlFile, found := bzlFileByPath[filePath]
		if !found {
			return nil, fmt.Errorf("file not found: %q (was in also included as a --bzl_file?)", filePath)
		}

		// if bzlFile.Label.Repo != "aspect_rules_js" || bzlFile.Label.Pkg != "contrib/nextjs" || bzlFile.Label.Name != "defs.bzl" {
		// 	cfg.Logger.Printf("skipping %s", filePath)
		// 	continue
		// }
		// cfg.Logger.Panicf("extracting %s: %+v", filePath, bzlFile.Label)

		file := &bzpb.FileInfo{Label: bzlFile.Label}

		module, err := extractModule(cfg, bzlFile)
		if err != nil {
			file.Error = err.Error()
			if cfg.ErrorLimit > 0 && errors > cfg.ErrorLimit {
				cfg.Logger.Panicf("🔴 failed to extract %+v: %v", bzlFile, err)
			} else {
				cfg.Logger.Printf("🔴 failed to extract %+v: %v", bzlFile, err)
			}
			errors++
		} else {
			stardoc.ModuleToFileInfo(file, module)
			// cfg.Logger.Printf("🟢 successfully extracted %s", bzlFile.Label)
			// cfg.Logger.Panicf("extracted %s: %+v", filePath, module)
		}

		result.File = append(result.File, file)
	}

	// Report success rate
	total := len(cfg.FilesToExtract)
	success := total - errors
	pct := float64(success) / float64(total) * 100.0
	cfg.Logger.Printf("Extraction: %d/%d %.1f%%", success, total, pct)

	return result, nil
}

func extractModule(cfg *config, file *bzlFile) (*slpb.Module, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	targetFileLabel := stardoc.LabelFromProto(file.Label).String()
	// log.Printf("targetFileLabel: %s", targetFileLabel)

	response, err := cfg.Client.ModuleInfo(ctx, &slpb.ModuleInfoRequest{
		TargetFileLabel: targetFileLabel,
		BuiltinsBzlPath: filepath.Join(cfg.Cwd, workDir, "external/_builtins/src/main/starlark/builtins_bzl"),
		DepRoots: []string{
			filepath.Join(cfg.Cwd, workDir),
		},
	})
	if err != nil {
		// Strip absolute path prefix from error messages
		cleanErr := cleanErrorMessage(err, cfg.Cwd)
		return nil, fmt.Errorf("ModuleInfo request error: %v", cleanErr)
	}

	return response, nil
}
