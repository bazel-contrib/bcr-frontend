package stardoc

import (
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
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
	file.Load = makeLoadInfoList(module.Load)
	file.Global = module.Global
	file.Symbol = makeSymbolsFromModule(module)
	file.Description = processDocString(module.ModuleDocstring)
}

func makeLoadInfoList(loadStmts []*slpb.LoadStmt) []*bzpb.LoadInfo {
	if len(loadStmts) == 0 {
		return nil
	}
	loads := make([]*bzpb.LoadInfo, len(loadStmts))
	for i, load := range loadStmts {
		loads[i] = makeLoadInfo(load)
	}
	return loads
}

func makeLoadInfo(load *slpb.LoadStmt) *bzpb.LoadInfo {
	return &bzpb.LoadInfo{
		Label:  ParseLabel(load.Label),
		Symbol: load.Symbol,
	}
}
