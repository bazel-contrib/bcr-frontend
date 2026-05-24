package main

// Reshape logic — turns a BuiltinInfoResponse into a ModuleVersionSymbols.
//
// Two stages:
//
//  1. Build a name-keyed lookup of rich stardoc AttributeInfo records from
//     the six bundled ModuleInfo protos (one per language module — cpp,
//     java, objc, proto, python, shell). Each carries fully-typed
//     RuleInfo.attribute entries that the upstream builtin.pb proto lacks.
//
//  2. Walk Builtins.global / Builtins.type and emit Symbols, applying the
//     same classification + display_name decoration the standalone
//     cmd/builtinscompiler does. While emitting each Rule symbol's
//     attribute list, opportunistically enrich each AttributeInfo from the
//     lookup built in step (1).
//
// Per-attribute enrichment (rather than wholesale Symbol.Info swap) keeps
// the builtins-side attribute list complete: complex native rules whose
// Starlark definition doesn't fully round-trip through constellate still
// render with their full attribute set, just without the type chips for
// attributes constellate couldn't extract.

import (
	"log"
	"regexp"

	htmlmd "github.com/JohannesKaufmann/html-to-markdown"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	builtinpb "github.com/bazel-contrib/bcr-frontend/builtin"
	sdpb "github.com/bazel-contrib/bcr-frontend/stardoc_output"
)

// htmlSniff matches an opening tag for one of the HTML elements Bazel
// actually emits in its builtin docstrings (genrule.srcs, etc.). Matching
// specific tags avoids false positives on plain text containing `<`, like
// "n <= 5" or "List<Foo>".
var htmlSniff = regexp.MustCompile(`(?i)<(?:p|code|pre|a\s|a>|em|b|i|br|li|ul|table)\b`)

// mdConverter is a package-level html-to-markdown.Converter. NewConverter
// is goroutine-safe per the upstream docs, so we cache one instance to
// amortize rule-setup cost across the many docstrings we process.
var mdConverter = htmlmd.NewConverter("", true, nil)

// docMD returns markdown text. If the input looks like HTML (per
// htmlSniff), runs it through the HTML→markdown converter; otherwise
// returns it unchanged. Failures fall back to the input so a malformed
// docstring never blanks the rendered docs.
func docMD(s string) string {
	if s == "" || !htmlSniff.MatchString(s) {
		return s
	}
	out, err := mdConverter.ConvertString(s)
	if err != nil {
		return s
	}
	return out
}

// reshape produces the ModuleVersionSymbols that flows downstream to
// moduleregistrysymbolscompiler. The (name, version) fields are
// intentionally left blank — the registry aggregator stamps them per-MV.
func reshape(resp *slpb.BuiltinInfoResponse, onlyNames stringSet) *sympb.ModuleVersionSymbols {
	mvs := &sympb.ModuleVersionSymbols{
		Source: sympb.SymbolSource_BEST_EFFORT,
	}
	b := resp.GetBuiltins()
	if b == nil {
		return mvs
	}

	// Stage 1: index the language-ModuleInfo attribute records by
	// rule-name → attribute-name → AttributeInfo.
	enrichByRule := buildEnrichmentIndex(resp.GetModuleInfo(), resp.GetModuleInfoSource())

	// Type lookup (also used for the namespace-struct branch + extras).
	typeByName := make(map[string]*builtinpb.Type, len(b.GetType()))
	for _, t := range b.GetType() {
		if t != nil {
			typeByName[t.GetName()] = t
		}
	}

	// Identify module globals (java_common, cc_common, native, …).
	moduleGlobalNames := make(map[string]bool)
	for _, v := range b.GetGlobal() {
		if v != nil && v.GetCallable() == nil && v.GetType() == v.GetName() && typeByName[v.GetName()] != nil {
			moduleGlobalNames[v.GetName()] = true
		}
	}
	isNativeType := func(name string) bool {
		return typeByName[name] != nil && !moduleGlobalNames[name]
	}

	// Partition globals: dotted names whose prefix matches a Type get
	// folded into that Type's module-namespace.
	extraFieldsByType := make(map[string][]*builtinpb.Value)
	topLevelGlobals := make([]*builtinpb.Value, 0, len(b.GetGlobal()))
	for _, v := range b.GetGlobal() {
		if v == nil {
			continue
		}
		prefix, _, dotted := splitNamespacePrefix(v.GetName())
		if dotted && typeByName[prefix] != nil {
			extraFieldsByType[prefix] = append(extraFieldsByType[prefix], v)
			continue
		}
		topLevelGlobals = append(topLevelGlobals, v)
	}

	rs := reshaper{
		typeByName:        typeByName,
		extraFieldsByType: extraFieldsByType,
		enrichByRule:      enrichByRule,
		onlyNames:         onlyNames,
	}

	if globals := rs.buildGlobalsFile(topLevelGlobals); globals != nil {
		mvs.File = append(mvs.File, globals)
	}
	for _, t := range b.GetType() {
		if f := rs.buildTypeFile(t, extraFieldsByType[t.GetName()], isNativeType(t.GetName())); f != nil {
			mvs.File = append(mvs.File, f)
		}
	}
	return mvs
}

type reshaper struct {
	typeByName        map[string]*builtinpb.Type
	extraFieldsByType map[string][]*builtinpb.Value
	// enrichByRule[ruleName][attrName] = AttributeInfo with full type +
	// docstring info, sourced from the six language ModuleInfos.
	enrichByRule map[string]map[string]*sdpb.AttributeInfo
	onlyNames    stringSet
}

func (r *reshaper) buildGlobalsFile(globals []*builtinpb.Value) *sympb.File {
	if len(globals) == 0 {
		return nil
	}
	f := &sympb.File{
		Label:       &slpb.Label{Name: "globals"},
		Description: "Symbols available in every BUILD and .bzl file's global scope.",
	}
	for _, v := range globals {
		// Top-level globals never get a display_name override — the
		// undecorated name is already idiomatic (cc_library, glob, …).
		if sym := r.valueToSymbol(v, v.GetName(), "" /*displayName*/, true /*allowStructBranch*/); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	return f
}

func (r *reshaper) buildTypeFile(t *builtinpb.Type, extras []*builtinpb.Value, isNative bool) *sympb.File {
	if t == nil {
		return nil
	}
	f := &sympb.File{
		Label:       &slpb.Label{Name: t.GetName()},
		Description: docMD(t.GetDoc()),
	}
	for _, v := range t.GetField() {
		qualified := t.GetName() + "." + v.GetName()
		displayName := ""
		if isNative {
			displayName = "<" + t.GetName() + ">." + v.GetName()
		}
		// Fields of a Type don't get the module-struct treatment; pass
		// allowStructBranch=false so they don't accidentally classify.
		if sym := r.valueToSymbol(v, qualified, displayName, false); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	// Globals whose dotted name slotted under this Type — emit a Symbol
	// per entry so navigation from the struct field's qualified_name
	// resolves. Module-flavored, so no display_name decoration.
	for _, v := range extras {
		if sym := r.valueToSymbol(v, v.GetName(), "", false); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	return f
}

// buildOnlyNonRules names BUILD-only callables that are NOT rules — they
// look like rules to the upstream proto but are conceptually helper
// functions. Kept in sync with cmd/builtinscompiler/main.go.
var buildOnlyNonRules = map[string]bool{
	"glob":                   true,
	"module_name":            true,
	"module_version":         true,
	"package_name":           true,
	"package_relative_label": true,
	"repo_name":              true,
	"repository_name":        true,
	"subpackages":            true,
}

// valueToSymbol mirrors cmd/builtinscompiler's classification logic and
// additionally enriches Rule attributes from the ModuleInfo-derived
// lookup.
func (r *reshaper) valueToSymbol(v *builtinpb.Value, name, displayName string, allowStructBranch bool) *sympb.Symbol {
	if v == nil {
		return nil
	}
	// Convert any HTML in the upstream docstring to markdown once;
	// reused as both the (decorated) description and the typed-payload
	// DocString so the rendered docs stay consistent across surfaces.
	doc := docMD(v.GetDoc())
	description := decorateDoc(v.GetApiContext(), doc)

	// Namespace-global struct branch (java_common, cc_common, native, …).
	if allowStructBranch && v.GetCallable() == nil && v.GetType() == v.GetName() {
		if t := r.typeByName[v.GetName()]; t != nil {
			return &sympb.Symbol{
				Type:        sympb.SymbolType_SYMBOL_TYPE_STRUCT,
				Name:        name,
				DisplayName: displayName,
				Description: description,
				Info: &sympb.Symbol_Struct{
					Struct: &slpb.Struct{
						Name:      name,
						DocString: doc,
						Field:     typeFieldsToStructFields(t, r.extraFieldsByType[v.GetName()]),
					},
				},
			}
		}
	}

	if v.GetCallable() != nil {
		if v.GetApiContext() == builtinpb.ApiContext_BUILD && !buildOnlyNonRules[v.GetName()] {
			attrs := paramsToAttributes(v.GetCallable().GetParam())
			wrapped := paramsToWrappedAttributes(v.GetCallable().GetParam())
			r.enrichRuleAttributes(name, attrs, wrapped)
			return &sympb.Symbol{
				Type:        sympb.SymbolType_SYMBOL_TYPE_RULE,
				Name:        name,
				DisplayName: displayName,
				Description: description,
				Info: &sympb.Symbol_Rule{
					Rule: &slpb.Rule{
						Info: &sdpb.RuleInfo{
							RuleName:  name,
							DocString: doc,
							Attribute: attrs,
						},
						Attribute: wrapped,
					},
				},
			}
		}
		return &sympb.Symbol{
			Type:        sympb.SymbolType_SYMBOL_TYPE_FUNCTION,
			Name:        name,
			DisplayName: displayName,
			Description: description,
			Info: &sympb.Symbol_Func{
				Func: &slpb.Function{
					Info: &sdpb.StarlarkFunctionInfo{
						FunctionName: name,
						DocString:    doc,
						Parameter:    paramsToFunctionParams(v.GetCallable().GetParam()),
						Return:       returnInfo(v.GetCallable().GetReturnType()),
					},
				},
			},
		}
	}
	return &sympb.Symbol{
		Type:        sympb.SymbolType_SYMBOL_TYPE_VALUE,
		Name:        name,
		DisplayName: displayName,
		Description: description,
		Info: &sympb.Symbol_Value{
			Value: valueForNonCallable(v.GetType()),
		},
	}
}

// enrichRuleAttributes fills opportunistic type/docstring/provider fields
// from the ModuleInfo-derived lookup into the just-built attribute lists.
// When onlyNames is non-empty, names outside the set pass through
// unenriched so the user can A/B before / after for a specific rule.
func (r *reshaper) enrichRuleAttributes(ruleName string, attrs []*sdpb.AttributeInfo, wrapped []*slpb.Attribute) {
	if len(r.onlyNames) > 0 && !r.onlyNames[ruleName] {
		return
	}
	enrich := r.enrichByRule[ruleName]
	if len(enrich) == 0 {
		return
	}
	for _, a := range attrs {
		if rich, ok := enrich[a.GetName()]; ok {
			enrichAttributeInfo(a, rich)
		}
	}
	for _, w := range wrapped {
		if rich, ok := enrich[w.GetInfo().GetName()]; ok {
			enrichAttributeInfo(w.GetInfo(), rich)
		}
	}
}

// enrichAttributeInfo copies opportunistically. The builtins-side fields
// the upstream proto sets (name, mandatory, default_value) are kept
// because they reflect Bazel's runtime reality. The ModuleInfo side fills
// in fields the builtins reshape can't compute (type enum, rich
// doc_string, provider constraints, nonconfigurable flag).
func enrichAttributeInfo(dst, src *sdpb.AttributeInfo) {
	if dst.GetType() == sdpb.AttributeType_UNKNOWN && src.GetType() != sdpb.AttributeType_UNKNOWN {
		dst.Type = src.Type
	}
	if dst.GetDocString() == "" && src.GetDocString() != "" {
		// Stardoc docstrings are markdown-native, so docMD is a no-op
		// in the common case; we run it anyway in case a ModuleInfo
		// path ever surfaces HTML.
		dst.DocString = docMD(src.GetDocString())
	}
	if len(dst.GetProviderNameGroup()) == 0 && len(src.GetProviderNameGroup()) > 0 {
		dst.ProviderNameGroup = src.ProviderNameGroup
	}
	if !dst.GetNonconfigurable() && src.GetNonconfigurable() {
		dst.Nonconfigurable = true
	}
	if !dst.GetNativelyDefined() && src.GetNativelyDefined() {
		dst.NativelyDefined = true
	}
}

// buildEnrichmentIndex builds rule-name → attr-name → AttributeInfo from
// the six language ModuleInfos. Logs the totals for visibility during
// builds (helpful when chasing "why aren't my attributes typed?" issues).
func buildEnrichmentIndex(modules []*sdpb.ModuleInfo, sources []string) map[string]map[string]*sdpb.AttributeInfo {
	out := make(map[string]map[string]*sdpb.AttributeInfo)
	for i, m := range modules {
		src := ""
		if i < len(sources) {
			src = sources[i]
		}
		ruleCount := 0
		for _, rule := range m.GetRuleInfo() {
			name := rule.GetRuleName()
			if name == "" {
				continue
			}
			byAttr := out[name]
			if byAttr == nil {
				byAttr = make(map[string]*sdpb.AttributeInfo)
				out[name] = byAttr
			}
			for _, a := range rule.GetAttribute() {
				if a.GetName() == "" {
					continue
				}
				// First populated wins. If two language modules
				// disagree on the same rule, the first one is taken;
				// in practice they don't overlap.
				if _, exists := byAttr[a.GetName()]; !exists {
					byAttr[a.GetName()] = a
				}
			}
			ruleCount++
		}
		log.Printf("indexed %d rules from module_info[%s]", ruleCount, src)
	}
	return out
}

// splitNamespacePrefix splits "java_common.BootClassPathInfo" →
// ("java_common", "BootClassPathInfo", true). Returns ("", name, false)
// when there's no dot.
func splitNamespacePrefix(name string) (string, string, bool) {
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			return name[:i], name[i+1:], true
		}
	}
	return "", name, false
}

// typeFieldsToStructFields builds the StructField list that cross-
// references the per-field symbols emitted into the Type's synthetic file.
func typeFieldsToStructFields(t *builtinpb.Type, extras []*builtinpb.Value) []*slpb.StructField {
	out := make([]*slpb.StructField, 0, len(t.GetField())+len(extras))
	for _, f := range t.GetField() {
		if f == nil {
			continue
		}
		out = append(out, &slpb.StructField{
			Name:          f.GetName(),
			TargetSymbol:  f.GetName(),
			QualifiedName: t.GetName() + "." + f.GetName(),
		})
	}
	for _, e := range extras {
		if e == nil {
			continue
		}
		_, suffix, _ := splitNamespacePrefix(e.GetName())
		out = append(out, &slpb.StructField{
			Name:          suffix,
			TargetSymbol:  suffix,
			QualifiedName: e.GetName(),
		})
	}
	return out
}

// valueForNonCallable returns an empty slpb.Value for non-callable
// builtins. The upstream builtin.Value carries a free-form type string
// (e.g. "bool", "NoneType"), but the slpb.Value oneof has no slot for it
// at the moment, so we drop it on the floor. If we want the type chip
// back, add a tagged string field to the Value oneof in starlark.proto.
func valueForNonCallable(typeName string) *slpb.Value {
	_ = typeName
	return &slpb.Value{}
}

// returnInfo packages a Callable.return_type into a FunctionReturnInfo.
// FunctionReturnInfo has no dedicated type field, so we wrap the type-name
// string in backticks (markdown inline-code) inside doc_string. Returns
// nil if the type name is empty so the frontend omits the section.
func returnInfo(returnType string) *sdpb.FunctionReturnInfo {
	if returnType == "" {
		return nil
	}
	return &sdpb.FunctionReturnInfo{
		DocString: "`" + returnType + "`",
	}
}

func paramsToFunctionParams(params []*builtinpb.Param) []*sdpb.FunctionParamInfo {
	out := make([]*sdpb.FunctionParamInfo, 0, len(params))
	for _, p := range params {
		out = append(out, &sdpb.FunctionParamInfo{
			Name:         p.GetName(),
			DocString:    docMD(p.GetDoc()),
			DefaultValue: p.GetDefaultValue(),
			Mandatory:    p.GetIsMandatory(),
			Role:         paramRole(p),
		})
	}
	return out
}

// paramsToAttributes flattens builtin.Param entries into stardoc
// AttributeInfo records. The upstream `Param.type` is a free-form string
// and can't be mapped onto the stardoc AttributeType enum cleanly; the
// enrichment pass fills it in from the ModuleInfo-derived lookup.
func paramsToAttributes(params []*builtinpb.Param) []*sdpb.AttributeInfo {
	out := make([]*sdpb.AttributeInfo, 0, len(params))
	for _, p := range params {
		out = append(out, &sdpb.AttributeInfo{
			Name:         p.GetName(),
			DocString:    docMD(p.GetDoc()),
			DefaultValue: p.GetDefaultValue(),
			Mandatory:    p.GetIsMandatory(),
		})
	}
	return out
}

// paramsToWrappedAttributes returns the same list re-wrapped as the
// Rule.attribute oneof carries (slpb.Attribute, which embeds AttributeInfo).
func paramsToWrappedAttributes(params []*builtinpb.Param) []*slpb.Attribute {
	infos := paramsToAttributes(params)
	out := make([]*slpb.Attribute, 0, len(infos))
	for _, info := range infos {
		out = append(out, &slpb.Attribute{Info: info})
	}
	return out
}

func paramRole(p *builtinpb.Param) sdpb.FunctionParamRole {
	switch {
	case p.GetIsStarArg():
		return sdpb.FunctionParamRole_PARAM_ROLE_VARARGS
	case p.GetIsStarStarArg():
		return sdpb.FunctionParamRole_PARAM_ROLE_KWARGS
	default:
		return sdpb.FunctionParamRole_PARAM_ROLE_ORDINARY
	}
}

// decorateDoc prepends an ApiContext tag to the doc text when the symbol
// is restricted to BZL or BUILD scope. Markdown-friendly so the rendered
// chip is set off visually.
func decorateDoc(ctx builtinpb.ApiContext, doc string) string {
	switch ctx {
	case builtinpb.ApiContext_BZL:
		return prefixTag("[`.bzl` only]", doc)
	case builtinpb.ApiContext_BUILD:
		return prefixTag("[`BUILD` only]", doc)
	default:
		return doc
	}
}

func prefixTag(tag, doc string) string {
	if doc == "" {
		return tag
	}
	return tag + " " + doc
}
