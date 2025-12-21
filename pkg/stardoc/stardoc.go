package stardoc

import (
	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
	sdpb "github.com/stackb/centrl/stardoc_output"
)

// ModuleInfoToFileInfo converts a stardoc ModuleInfo into a FileInfo message
func ModuleInfoToFileInfo(module *sdpb.ModuleInfo) *bzpb.FileInfo {
	return &bzpb.FileInfo{
		Label:       ParseLabel(module.File),
		Symbol:      makeSymbolsFromModuleInfo(module),
		Description: processDocString(module.ModuleDocstring),
	}
}

// ModuleToFileInfo converts a slpb.Module to a bzpb.FileInfo
func ModuleToFileInfo(file *bzpb.FileInfo, module *slpb.Module) {
	file.Symbol = makeSymbolsFromModule(module)
	file.Description = processDocString(module.ModuleDocstring)
}
