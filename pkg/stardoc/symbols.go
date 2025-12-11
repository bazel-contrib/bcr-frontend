package stardoc

import (
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
	sdpb "github.com/stackb/centrl/stardoc_output"
)

func processDocString(doc string) string {
	return Dedent(doc)
}

func processSymbolLocation(location *slpb.SymbolLocation) {
	if location != nil {
		location.Name = "" // no longer useful, save space
	}
}

func processAttribute(attr *slpb.Attribute) {
	attr.Info.DocString = processDocString(attr.Info.DocString)
	processSymbolLocation(attr.Location)
}

func processFunctionParam(param *slpb.FunctionParam) {
	param.Info.DocString = processDocString(param.Info.DocString)
	processSymbolLocation(param.Location)
}

func processRule(rule *slpb.Rule) {
	rule.Info.DocString = processDocString(rule.Info.DocString)
	for _, attr := range rule.Info.Attribute {
		attr.DocString = processDocString(attr.DocString)
	}
	for _, attr := range rule.Attribute {
		processAttribute(attr)
	}
	processSymbolLocation(rule.Location)
}

func processFunction(function *slpb.Function) {
	function.Info.DocString = processDocString(function.Info.DocString)

	// TODO: how can this be nil?
	if function.Info.Return != nil {
		function.Info.Return.DocString = processDocString(function.Info.Return.DocString)
	}

	for _, param := range function.Info.Parameter {
		param.DocString = processDocString(param.DocString)
	}
	for _, param := range function.Param {
		processFunctionParam(param)
	}
	processSymbolLocation(function.Location)
}

func processProviderField(field *slpb.ProviderField) {
	field.Info.DocString = processDocString(field.Info.DocString)
	processSymbolLocation(field.Location)
}

func processProvider(provider *slpb.Provider) {
	provider.Info.DocString = processDocString(provider.Info.DocString)
	for _, field := range provider.Info.FieldInfo {
		field.DocString = processDocString(field.DocString)
	}
	for _, field := range provider.Field {
		processProviderField(field)
	}
	processSymbolLocation(provider.Location)
}

func processAspect(aspect *slpb.Aspect) {
	aspect.Info.DocString = processDocString(aspect.Info.DocString)
	for _, attr := range aspect.Info.Attribute {
		attr.DocString = processDocString(attr.DocString)
	}
	for _, attr := range aspect.Attribute {
		processAttribute(attr)
	}
	processSymbolLocation(aspect.Location)
}

func processModuleExtensionTagClass(tagClass *slpb.ModuleExtensionTagClass) {
	tagClass.Info.DocString = processDocString(tagClass.Info.DocString)
	for _, attr := range tagClass.Info.Attribute {
		attr.DocString = processDocString(attr.DocString)
	}
	for _, attr := range tagClass.Attribute {
		processAttribute(attr)
	}
	tagClass.Info.DocString = processDocString(tagClass.Info.DocString)
	processSymbolLocation(tagClass.Location)
}

func processModuleExtension(ext *slpb.ModuleExtension) {
	ext.Info.DocString = processDocString(ext.Info.DocString)
	for _, tagClass := range ext.Info.TagClass {
		tagClass.DocString = processDocString(tagClass.DocString)
	}
	for _, tagClass := range ext.TagClass {
		processModuleExtensionTagClass(tagClass)
	}
	processSymbolLocation(ext.Location)
}

func processRepositoryRule(repoRule *slpb.RepositoryRule) {
	repoRule.Info.DocString = processDocString(repoRule.Info.DocString)
	for _, attr := range repoRule.Info.Attribute {
		attr.DocString = processDocString(attr.DocString)
	}
	for _, attr := range repoRule.Attribute {
		processAttribute(attr)
	}
	processSymbolLocation(repoRule.Location)
}

func processMacro(macro *slpb.Macro) {
	macro.Info.DocString = processDocString(macro.Info.DocString)
	for _, attr := range macro.Info.Attribute {
		attr.DocString = processDocString(attr.DocString)
	}
	for _, attr := range macro.Attribute {
		processAttribute(attr)
	}
	processSymbolLocation(macro.Location)
}

func makeAttribute(info *sdpb.AttributeInfo) *slpb.Attribute {
	return &slpb.Attribute{
		Info: info,
	}
}

func makeAttributes(infos []*sdpb.AttributeInfo) []*slpb.Attribute {
	attrs := make([]*slpb.Attribute, len(infos))
	for i, info := range infos {
		attrs[i] = makeAttribute(info)
	}
	return attrs
}

func makeFunctionParam(info *sdpb.FunctionParamInfo) *slpb.FunctionParam {
	return &slpb.FunctionParam{
		Info: info,
	}
}

// func makeFunctionReturn(ret []*sdpb.FunctionReturnInfo) *slpb. {
// 	params := make([]*slpb.FunctionParam, len(ret))
// 	for i, info := range ret {
// 		params[i] = makeFunctionParam(info)
// 	}
// 	return params
// }

func makeFunctionParams(infos []*sdpb.FunctionParamInfo) []*slpb.FunctionParam {
	params := make([]*slpb.FunctionParam, len(infos))
	for i, info := range infos {
		params[i] = makeFunctionParam(info)
	}
	return params
}

func makeProviderField(info *sdpb.ProviderFieldInfo) *slpb.ProviderField {
	return &slpb.ProviderField{
		Info: info,
	}
}

func makeProviderFields(infos []*sdpb.ProviderFieldInfo) []*slpb.ProviderField {
	fields := make([]*slpb.ProviderField, len(infos))
	for i, info := range infos {
		fields[i] = makeProviderField(info)
	}
	return fields
}

func makeModuleExtensionTagClass(info *sdpb.ModuleExtensionTagClassInfo) *slpb.ModuleExtensionTagClass {
	return &slpb.ModuleExtensionTagClass{
		Info:      info,
		Attribute: makeAttributes(info.Attribute),
	}
}

func makeModuleExtensionTagClasss(infos []*sdpb.ModuleExtensionTagClassInfo) []*slpb.ModuleExtensionTagClass {
	tagClasses := make([]*slpb.ModuleExtensionTagClass, len(infos))
	for i, info := range infos {
		tagClasses[i] = makeModuleExtensionTagClass(info)
	}
	return tagClasses
}

func makeRuleSymbol(info *sdpb.RuleInfo, rule *slpb.Rule) *bzpb.SymbolInfo {
	if rule == nil {
		rule = &slpb.Rule{
			Info:      info,
			Attribute: makeAttributes(info.Attribute),
		}
	}
	processRule(rule)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_RULE,
		Name:        info.RuleName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_Rule{Rule: rule},
	}
}

func makeFunctionSymbol(info *sdpb.StarlarkFunctionInfo, function *slpb.Function) *bzpb.SymbolInfo {
	if function == nil {
		function = &slpb.Function{
			Info:  info,
			Param: makeFunctionParams(info.Parameter),
		}
	}
	processFunction(function)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_FUNCTION,
		Name:        info.FunctionName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_Func{Func: function},
	}
}

func makeProviderSymbol(info *sdpb.ProviderInfo, provider *slpb.Provider) *bzpb.SymbolInfo {
	if provider == nil {
		provider = &slpb.Provider{
			Info:  info,
			Field: makeProviderFields(info.FieldInfo),
		}
	}
	processProvider(provider)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_PROVIDER,
		Name:        info.ProviderName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_Provider{Provider: provider},
	}
}

func makeAspectSymbol(info *sdpb.AspectInfo, aspect *slpb.Aspect) *bzpb.SymbolInfo {
	if aspect == nil {
		aspect = &slpb.Aspect{
			Info:      info,
			Attribute: makeAttributes(info.Attribute),
		}
	}
	processAspect(aspect)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_ASPECT,
		Name:        info.AspectName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_Aspect{Aspect: aspect},
	}
}

func makeModuleExtensionSymbol(info *sdpb.ModuleExtensionInfo, ext *slpb.ModuleExtension) *bzpb.SymbolInfo {
	if ext == nil {
		ext = &slpb.ModuleExtension{
			Info:     info,
			TagClass: makeModuleExtensionTagClasss(info.TagClass),
		}
	}
	processModuleExtension(ext)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_MODULE_EXTENSION,
		Name:        info.ExtensionName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_ModuleExtension{ModuleExtension: ext},
	}
}

func makeRepositoryRuleSymbol(info *sdpb.RepositoryRuleInfo, repoRule *slpb.RepositoryRule) *bzpb.SymbolInfo {
	if repoRule == nil {
		repoRule = &slpb.RepositoryRule{
			Info:      info,
			Attribute: makeAttributes(info.Attribute),
		}
	}
	processRepositoryRule(repoRule)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_REPOSITORY_RULE,
		Name:        info.RuleName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_RepositoryRule{RepositoryRule: repoRule},
	}
}

func makeMacroSymbol(info *sdpb.MacroInfo, macro *slpb.Macro) *bzpb.SymbolInfo {
	if macro == nil {
		macro = &slpb.Macro{
			Info:      info,
			Attribute: makeAttributes(info.Attribute),
		}
	}
	processMacro(macro)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_MACRO,
		Name:        info.MacroName,
		Description: processDocString(info.DocString),
		Info:        &bzpb.SymbolInfo_Macro{Macro: macro},
	}
}

func makeRuleMacro(ruleMacro *slpb.RuleMacro) *bzpb.SymbolInfo {
	// Get description from rule or function
	description := ruleMacro.Function.Info.DocString
	if description == "" {
		description = ruleMacro.Rule.Info.DocString
	}
	processRule(ruleMacro.Rule)
	processFunction(ruleMacro.Function)
	return &bzpb.SymbolInfo{
		Type:        bzpb.SymbolType_SYMBOL_TYPE_RULE_MACRO,
		Name:        ruleMacro.Function.Info.FunctionName,
		Description: processDocString(description),
		Info:        &bzpb.SymbolInfo_RuleMacro{RuleMacro: ruleMacro},
	}
}

// makeSymbolsFromModuleInfo extracts all symbols from a ModuleInfo
func makeSymbolsFromModuleInfo(module *sdpb.ModuleInfo) []*bzpb.SymbolInfo {
	var symbols []*bzpb.SymbolInfo

	// Process rules
	for _, rule := range module.RuleInfo {
		symbols = append(symbols, makeRuleSymbol(rule, nil))
	}

	// Process functions
	for _, fn := range module.FuncInfo {
		symbols = append(symbols, makeFunctionSymbol(fn, nil))
	}

	// Process providers
	for _, provider := range module.ProviderInfo {
		symbols = append(symbols, makeProviderSymbol(provider, nil))
	}

	// Process aspects
	for _, aspect := range module.AspectInfo {
		symbols = append(symbols, makeAspectSymbol(aspect, nil))
	}

	// Process module extensions
	for _, ext := range module.ModuleExtensionInfo {
		symbols = append(symbols, makeModuleExtensionSymbol(ext, nil))
	}

	// Process repository rules
	for _, repoRule := range module.RepositoryRuleInfo {
		symbols = append(symbols, makeRepositoryRuleSymbol(repoRule, nil))
	}

	// Process macros
	for _, macro := range module.MacroInfo {
		symbols = append(symbols, makeMacroSymbol(macro, nil))
	}

	return symbols
}

// makeSymbolsFromModule extracts all symbols from a slpb.Module with location
// information
func makeSymbolsFromModule(module *slpb.Module) []*bzpb.SymbolInfo {
	if module == nil {
		return nil
	}

	var symbols []*bzpb.SymbolInfo

	// Process rules
	for _, rule := range module.Rule {
		symbols = append(symbols, makeRuleSymbol(rule.Info, rule))
	}

	// Process functions (skip if there's a RuleMacro with the same name)
	for _, fn := range module.Function {
		symbols = append(symbols, makeFunctionSymbol(fn.Info, fn))
	}

	// Process providers
	for _, provider := range module.Provider {
		symbols = append(symbols, makeProviderSymbol(provider.Info, provider))
	}

	// Process aspects
	for _, aspect := range module.Aspect {
		symbols = append(symbols, makeAspectSymbol(aspect.Info, aspect))
	}

	// Process repository rules
	for _, repoRule := range module.RepositoryRule {
		symbols = append(symbols, makeRepositoryRuleSymbol(repoRule.Info, repoRule))
	}

	// Process module extensions
	for _, ext := range module.ModuleExtension {
		symbols = append(symbols, makeModuleExtensionSymbol(ext.Info, ext))
	}

	// Process macros
	for _, macro := range module.Macro {
		symbols = append(symbols, makeMacroSymbol(macro.Info, macro))
	}

	// Process rule macros
	for _, ruleMacro := range module.RuleMacro {
		symbols = append(symbols, makeRuleMacro(ruleMacro))
	}

	return symbols
}
