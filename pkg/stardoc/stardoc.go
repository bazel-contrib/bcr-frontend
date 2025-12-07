package stardoc

import (
	"github.com/bazelbuild/bazel-gazelle/label"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
	sdpb "github.com/stackb/centrl/stardoc_output"
)

// ParseModuleFile converts a stardoc ModuleInfo into a FileInfo message
func ParseModuleFile(module *sdpb.ModuleInfo) *bzpb.FileInfo {
	label := ParseLabel(module.File)

	fileInfo := &bzpb.FileInfo{
		Label:       label,
		Symbol:      ParseModuleSymbols(module),
		Description: Truncate(module.ModuleDocstring),
	}

	return fileInfo
}

// ParseModuleSymbols extracts all symbols from a ModuleInfo
// Deprecated: Use ParseModuleSymbolsWithLocation for symbols with location information
func ParseModuleSymbols(module *sdpb.ModuleInfo) []*bzpb.SymbolInfo {
	var symbols []*bzpb.SymbolInfo

	// Process rules
	for _, rule := range module.RuleInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_RULE,
			Name:        rule.RuleName,
			Description: Truncate(rule.DocString),
			Info:        &bzpb.SymbolInfo_Rule{Rule: &slpb.Rule{Info: rule}},
		})
	}

	// Process functions
	for _, fn := range module.FuncInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_FUNCTION,
			Name:        fn.FunctionName,
			Description: Truncate(fn.DocString),
			Info:        &bzpb.SymbolInfo_Func{Func: &slpb.Function{Info: fn}},
		})
	}

	// Process providers
	for _, provider := range module.ProviderInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_PROVIDER,
			Name:        provider.ProviderName,
			Description: Truncate(provider.DocString),
			Info:        &bzpb.SymbolInfo_Provider{Provider: &slpb.Provider{Info: provider}},
		})
	}

	// Process aspects
	for _, aspect := range module.AspectInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_ASPECT,
			Name:        aspect.AspectName,
			Description: Truncate(aspect.DocString),
			Info:        &bzpb.SymbolInfo_Aspect{Aspect: &slpb.Aspect{Info: aspect}},
		})
	}

	// Process module extensions
	for _, ext := range module.ModuleExtensionInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_MODULE_EXTENSION,
			Name:        ext.ExtensionName,
			Description: Truncate(ext.DocString),
			Info:        &bzpb.SymbolInfo_ModuleExtension{ModuleExtension: &slpb.ModuleExtension{Info: ext}},
		})
	}

	// Process repository rules
	for _, repoRule := range module.RepositoryRuleInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_REPOSITORY_RULE,
			Name:        repoRule.RuleName,
			Description: Truncate(repoRule.DocString),
			Info:        &bzpb.SymbolInfo_RepositoryRule{RepositoryRule: &slpb.RepositoryRule{Info: repoRule}},
		})
	}

	// Process macros
	for _, macro := range module.MacroInfo {
		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_MACRO,
			Name:        macro.MacroName,
			Description: Truncate(macro.DocString),
			Info:        &bzpb.SymbolInfo_Macro{Macro: &slpb.Macro{Info: macro}},
		})
	}

	return symbols
}

// ParseModuleSymbolsWithLocation extracts all symbols from a slpb.Module with location information
func ParseModuleSymbolsWithLocation(module *slpb.Module) []*bzpb.SymbolInfo {
	if module == nil {
		return nil
	}

	var symbols []*bzpb.SymbolInfo

	// Build a map of symbol names to locations for quick lookup
	locations := make(map[string]*slpb.SymbolLocation)
	for _, loc := range module.SymbolLocation {
		locations[loc.Name] = loc
	}

	// If module has Info, process legacy types (rules, functions, providers, aspects)
	if module.Info != nil {
		// Process rules
		for _, rule := range module.Info.RuleInfo {
			loc := cloneLocationWithoutName(locations[rule.RuleName])
			symbols = append(symbols, &bzpb.SymbolInfo{
				Type:        bzpb.SymbolType_SYMBOL_TYPE_RULE,
				Name:        rule.RuleName,
				Description: Truncate(rule.DocString),
				Info: &bzpb.SymbolInfo_Rule{Rule: &slpb.Rule{
					Info:     rule,
					Location: loc,
				}},
			})
		}

		// Process functions
		for _, fn := range module.Info.FuncInfo {
			loc := cloneLocationWithoutName(locations[fn.FunctionName])
			symbols = append(symbols, &bzpb.SymbolInfo{
				Type:        bzpb.SymbolType_SYMBOL_TYPE_FUNCTION,
				Name:        fn.FunctionName,
				Description: Truncate(fn.DocString),
				Info: &bzpb.SymbolInfo_Func{Func: &slpb.Function{
					Info:     fn,
					Location: loc,
				}},
			})
		}

		// Process providers
		for _, provider := range module.Info.ProviderInfo {
			loc := cloneLocationWithoutName(locations[provider.ProviderName])
			symbols = append(symbols, &bzpb.SymbolInfo{
				Type:        bzpb.SymbolType_SYMBOL_TYPE_PROVIDER,
				Name:        provider.ProviderName,
				Description: Truncate(provider.DocString),
				Info: &bzpb.SymbolInfo_Provider{Provider: &slpb.Provider{
					Info:     provider,
					Location: loc,
				}},
			})
		}

		// Process aspects
		for _, aspect := range module.Info.AspectInfo {
			loc := cloneLocationWithoutName(locations[aspect.AspectName])
			symbols = append(symbols, &bzpb.SymbolInfo{
				Type:        bzpb.SymbolType_SYMBOL_TYPE_ASPECT,
				Name:        aspect.AspectName,
				Description: Truncate(aspect.DocString),
				Info: &bzpb.SymbolInfo_Aspect{Aspect: &slpb.Aspect{
					Info:     aspect,
					Location: loc,
				}},
			})
		}
	}

	// Process repository rules
	for _, repoRule := range module.RepositoryRule {
		name := ""
		if repoRule.Info != nil {
			name = repoRule.Info.RuleName
		}

		// Clone the repository rule and strip the name from its location
		clonedRepoRule := cloneRepositoryRuleWithoutLocationName(repoRule)

		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_REPOSITORY_RULE,
			Name:        name,
			Description: Truncate(repoRule.Info.GetDocString()),
			Info:        &bzpb.SymbolInfo_RepositoryRule{RepositoryRule: clonedRepoRule},
		})
	}

	// Process module extensions
	for _, ext := range module.ModuleExtension {
		name := ""
		if ext.Info != nil {
			name = ext.Info.ExtensionName
		}

		// Clone the module extension and strip the name from its location
		clonedExt := cloneModuleExtensionWithoutLocationName(ext)

		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_MODULE_EXTENSION,
			Name:        name,
			Description: Truncate(ext.Info.GetDocString()),
			Info:        &bzpb.SymbolInfo_ModuleExtension{ModuleExtension: clonedExt},
		})
	}

	// Process macros
	for _, macro := range module.Macro {
		name := ""
		if macro.Info != nil {
			name = macro.Info.MacroName
		}

		// Clone the macro and strip the name from its location
		clonedMacro := cloneMacroWithoutLocationName(macro)

		symbols = append(symbols, &bzpb.SymbolInfo{
			Type:        bzpb.SymbolType_SYMBOL_TYPE_MACRO,
			Name:        name,
			Description: Truncate(macro.Info.GetDocString()),
			Info:        &bzpb.SymbolInfo_Macro{Macro: clonedMacro},
		})
	}

	return symbols
}

// cloneLocationWithoutName creates a copy of a SymbolLocation with the name field set to empty
func cloneLocationWithoutName(loc *slpb.SymbolLocation) *slpb.SymbolLocation {
	if loc == nil {
		return nil
	}
	return &slpb.SymbolLocation{
		Start: loc.Start,
		End:   loc.End,
		Name:  "", // Clear the name to save space
	}
}

// cloneRepositoryRuleWithoutLocationName creates a copy of a RepositoryRule with the location name cleared
func cloneRepositoryRuleWithoutLocationName(rr *slpb.RepositoryRule) *slpb.RepositoryRule {
	if rr == nil {
		return nil
	}
	return &slpb.RepositoryRule{
		Info:      rr.Info,
		Location:  cloneLocationWithoutName(rr.Location),
		Attribute: rr.Attribute,
	}
}

// cloneModuleExtensionWithoutLocationName creates a copy of a ModuleExtension with the location name cleared
func cloneModuleExtensionWithoutLocationName(ext *slpb.ModuleExtension) *slpb.ModuleExtension {
	if ext == nil {
		return nil
	}
	return &slpb.ModuleExtension{
		Info:     ext.Info,
		Location: cloneLocationWithoutName(ext.Location),
		TagClass: ext.TagClass,
	}
}

// cloneMacroWithoutLocationName creates a copy of a Macro with the location name cleared
func cloneMacroWithoutLocationName(macro *slpb.Macro) *slpb.Macro {
	if macro == nil {
		return nil
	}
	return &slpb.Macro{
		Info:      macro.Info,
		Location:  cloneLocationWithoutName(macro.Location),
		Attribute: macro.Attribute,
	}
}

// ParseLabel parses a Bazel label string into its components
func ParseLabel(labelStr string) *bzpb.Label {
	l, err := label.Parse(labelStr)
	if err != nil {
		// If parsing fails, return empty label
		return &bzpb.Label{}
	}
	return ToLabel(l)
}

func ToLabel(l label.Label) *bzpb.Label {
	return &bzpb.Label{
		Repo: l.Repo,
		Pkg:  l.Pkg,
		Name: l.Name,
	}
}

func FromLabel(l *bzpb.Label) label.Label {
	return label.New(l.Repo, l.Pkg, l.Name)
}

// Truncate truncates a string to a reasonable length
func Truncate(s string) string {
	return s
	// const maxLen = 72
	// if len(s) <= maxLen {
	// 	return s
	// }
	// return s[:maxLen]
}

// ModuleToFileInfo converts a slpb.Module to a bzpb.FileInfo
func ModuleToFileInfo(file *bzpb.FileInfo, module *slpb.Module) {
	if module == nil {
		return
	}
	file.Description = Truncate(module.Info.ModuleDocstring)
	file.Symbol = ParseModuleSymbolsWithLocation(module)
	file.Load = module.Load
	file.Global = module.Global
}
