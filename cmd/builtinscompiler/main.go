// Command builtinscompiler reshapes a Bazel-produced builtin.Builtins proto
// into a ModuleVersionSymbols proto so it can flow through the existing
// per-module docs pipeline and surface at /modules/_builtins/<v>.
//
// Reshape:
//   - Builtins.global (callable=true)  → Symbol{type: FUNCTION, func: …}
//   - Builtins.global (callable=false) → Symbol{type: VALUE}
//   - Builtins.type                    → its fields are flattened into a
//     synthetic file (//:<type>.bzl)
//     with FUNCTION/VALUE symbols.
//
// All globals land in a single synthetic file "//:globals"; each type
// becomes "//:<type-name>". The labels deliberately omit a .bzl suffix —
// nothing is loadable from these "files", and the load-statement emitter in
// starlark.js suppresses the `load(...)` snippet when the file name doesn't
// end with .bzl. The module_name / version fields on the emitted
// ModuleVersionSymbols are intentionally left blank: the registry aggregator
// (moduleregistrysymbolscompiler) stamps them per-call so the same reshape
// can be replicated across every _builtins/<v> module-version.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	builtinpb "github.com/bazel-contrib/bcr-frontend/builtin"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
	sdpb "github.com/bazel-contrib/bcr-frontend/stardoc_output"
)

const toolName = "builtinscompiler"

type config struct {
	builtinsFile string
	outputFile   string
}

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return err
	}

	var builtins builtinpb.Builtins
	if err := protoutil.ReadFile(cfg.builtinsFile, &builtins); err != nil {
		return fmt.Errorf("reading %s: %v", cfg.builtinsFile, err)
	}

	mvs := reshape(&builtins)

	if err := protoutil.WriteFile(cfg.outputFile, mvs); err != nil {
		return fmt.Errorf("writing %s: %v", cfg.outputFile, err)
	}
	return nil
}

func parseFlags(args []string) (config, error) {
	var cfg config
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.builtinsFile, "builtins_file", "", "path to the input builtin.Builtins .pb file")
	fs.StringVar(&cfg.outputFile, "output_file", "", "path to write the output ModuleVersionSymbols .pb file")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	if cfg.builtinsFile == "" {
		return cfg, fmt.Errorf("--builtins_file is required")
	}
	if cfg.outputFile == "" {
		return cfg, fmt.Errorf("--output_file is required")
	}
	return cfg, nil
}

// reshape walks a builtin.Builtins and emits a ModuleVersionSymbols with one
// synthetic File per group of related symbols (globals + one per Type).
func reshape(b *builtinpb.Builtins) *sympb.ModuleVersionSymbols {
	mvs := &sympb.ModuleVersionSymbols{
		Source: sympb.SymbolSource_BEST_EFFORT,
	}

	// Index Types by name so the globals reshape can detect "module globals"
	// (e.g. java_common) — Values whose type matches their name and which
	// have a corresponding Type carrying the actual fields.
	typeByName := make(map[string]*builtinpb.Type, len(b.Type))
	for _, t := range b.Type {
		if t != nil {
			typeByName[t.Name] = t
		}
	}

	// Classify Types: module globals appear in both b.Type AND b.Global with
	// type == name (you write `java_common.create_provider(...)` — the prefix
	// is an identifier). Native types appear in b.Type only — you obtain
	// `File`, `Label`, `list` instances from APIs, you don't write them as
	// identifiers. The display_name on native-type fields gets angle-bracket
	// decoration to surface the distinction in the UI.
	moduleGlobalNames := make(map[string]bool)
	for _, v := range b.Global {
		if v != nil && v.Callable == nil && v.Type == v.Name && typeByName[v.Name] != nil {
			moduleGlobalNames[v.Name] = true
		}
	}
	isNativeType := func(name string) bool {
		return typeByName[name] != nil && !moduleGlobalNames[name]
	}

	// Partition globals: a global whose name is "<prefix>.<rest>" where
	// <prefix> matches a Type gets folded into that Type's module —
	// emitted as a Symbol in the Type's file AND as a StructField of the
	// Type's struct Symbol in the globals file. Catches cases like
	// java_common.BootClassPathInfo that the upstream proto records as a
	// top-level global with a dotted name but conceptually lives inside
	// the java_common module.
	extraFieldsByType := make(map[string][]*builtinpb.Value)
	topLevelGlobals := make([]*builtinpb.Value, 0, len(b.Global))
	for _, v := range b.Global {
		if v == nil {
			continue
		}
		prefix, _, dotted := splitNamespacePrefix(v.Name)
		if dotted && typeByName[prefix] != nil {
			extraFieldsByType[prefix] = append(extraFieldsByType[prefix], v)
			continue
		}
		topLevelGlobals = append(topLevelGlobals, v)
	}

	if globals := buildGlobalsFile(topLevelGlobals, typeByName, extraFieldsByType); globals != nil {
		mvs.File = append(mvs.File, globals)
	}
	for _, t := range b.Type {
		if f := buildTypeFile(t, extraFieldsByType[t.Name], isNativeType(t.Name)); f != nil {
			mvs.File = append(mvs.File, f)
		}
	}
	return mvs
}

// splitNamespacePrefix splits "java_common.BootClassPathInfo" → ("java_common",
// "BootClassPathInfo", true). Returns ("", name, false) when there's no dot.
func splitNamespacePrefix(name string) (string, string, bool) {
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			return name[:i], name[i+1:], true
		}
	}
	return "", name, false
}

func buildGlobalsFile(globals []*builtinpb.Value, typeByName map[string]*builtinpb.Type, extraFieldsByType map[string][]*builtinpb.Value) *sympb.File {
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
		if sym := valueToSymbol(v, v.Name, "", typeByName, extraFieldsByType); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	return f
}

func buildTypeFile(t *builtinpb.Type, extras []*builtinpb.Value, isNative bool) *sympb.File {
	if t == nil {
		return nil
	}
	f := &sympb.File{
		Label:       &slpb.Label{Name: t.Name},
		Description: t.Doc,
	}
	for _, v := range t.Field {
		// Qualify field names as "<type>.<name>" so they don't collide with
		// global symbols of the same name (e.g. list.append vs. tuple.append).
		qualified := t.Name + "." + v.Name
		// Native-type fields get an angle-bracket-decorated display_name so
		// the UI can visually flag that the prefix is a type, not a writable
		// identifier. Module-global fields leave display_name empty — the
		// undecorated `name` is already idiomatic.
		displayName := ""
		if isNative {
			displayName = "<" + t.Name + ">." + v.Name
		}
		// Don't pass typeByName here — fields of a type don't get the
		// module-struct treatment; only top-level globals do.
		if sym := valueToSymbol(v, qualified, displayName, nil, nil); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	// Globals whose dotted name slotted under this Type — emit a Symbol per
	// entry so navigation from the struct field's qualified_name resolves.
	// These are module-flavored (java_common.BootClassPathInfo), so no
	// display_name decoration.
	for _, v := range extras {
		if sym := valueToSymbol(v, v.Name, "", nil, nil); sym != nil {
			f.Symbol = append(f.Symbol, sym)
		}
	}
	return f
}

// buildOnlyNonRules names BUILD-only callables that are *not* rules — i.e.
// helper functions whose ApiContext is BUILD but which the upstream Bazel
// proto categorizes alongside cc_binary / filegroup / genrule. These render
// as FUNCTION symbols, not RULE symbols.
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

// valueToSymbol converts a builtin.Value into a symbol.Symbol.
//
//   - non-callable, type == name, matching Type exists → STRUCT (e.g. java_common)
//   - BUILD-only callable (not in buildOnlyNonRules)   → RULE   (e.g. cc_binary, filegroup)
//   - any-other callable                                → FUNCTION
//   - non-callable                                      → VALUE
//
// The BUILD-only/RULE classification matters because the frontend renders
// rule symbols as Bazel rule call sites (with attributes), whereas functions
// render as Python-style calls (with params). Most BUILD-only callables are
// conceptually rules even though the upstream proto labels them as Values;
// the buildOnlyNonRules allow-list captures the helpers that aren't.
//
// The STRUCT branch promotes namespace globals (e.g. java_common, native,
// cc_common) — values whose self-typed name has a matching Type in the
// Builtins.type list. Their StructField entries cross-reference the
// per-field symbols already emitted into that Type's synthetic file.
//
// `name` is the canonical/qualified name (used in URLs and links).
// `displayName` is an optional decorated label used for visible UI surfaces
// (sidebar rows, headings). Empty string means "no decoration" — the UI
// falls back to `name`. `typeByName` is the Type lookup map; pass nil to
// suppress the module-struct branch. `extraFieldsByType` carries dotted-name
// globals folded into each Type's module; pass nil to suppress.
func valueToSymbol(v *builtinpb.Value, name, displayName string, typeByName map[string]*builtinpb.Type, extraFieldsByType map[string][]*builtinpb.Value) *sympb.Symbol {
	if v == nil {
		return nil
	}
	description := decorateDoc(v.ApiContext, v.Doc)
	if v.Callable == nil && v.Type == v.Name && typeByName != nil {
		if t := typeByName[v.Name]; t != nil {
			return &sympb.Symbol{
				Type:        sympb.SymbolType_SYMBOL_TYPE_STRUCT,
				Name:        name,
				DisplayName: displayName,
				Description: description,
				Info: &sympb.Symbol_Struct{
					Struct: &slpb.Struct{
						Name:      name,
						DocString: v.Doc,
						Field:     typeFieldsToStructFields(t, extraFieldsByType[v.Name]),
					},
				},
			}
		}
	}
	if v.Callable != nil {
		if v.ApiContext == builtinpb.ApiContext_BUILD && !buildOnlyNonRules[v.Name] {
			return &sympb.Symbol{
				Type:        sympb.SymbolType_SYMBOL_TYPE_RULE,
				Name:        name,
				DisplayName: displayName,
				Description: description,
				Info: &sympb.Symbol_Rule{
					Rule: &slpb.Rule{
						Info: &sdpb.RuleInfo{
							RuleName:  name,
							DocString: v.Doc,
							Attribute: paramsToAttributes(v.Callable.Param),
						},
						Attribute: paramsToWrappedAttributes(v.Callable.Param),
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
						DocString:    v.Doc,
						Parameter:    paramsToFunctionParams(v.Callable.Param),
						Return:       returnInfo(v.Callable.ReturnType),
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
			Value: valueForNonCallable(v.Type),
		},
	}
}

// typeFieldsToStructFields builds the StructField list that cross-references
// the per-field symbols emitted into the Type's synthetic file (see
// buildTypeFile). Each entry's qualified_name matches the symbol name used
// there ("<type>.<field>") so navigation can resolve.
//
// `extras` are dotted-name globals (e.g. java_common.BootClassPathInfo) that
// got folded into this Type's namespace by reshape(); their full name is
// already qualified so we strip the prefix when populating Name/TargetSymbol.
func typeFieldsToStructFields(t *builtinpb.Type, extras []*builtinpb.Value) []*slpb.StructField {
	out := make([]*slpb.StructField, 0, len(t.Field)+len(extras))
	for _, f := range t.Field {
		if f == nil {
			continue
		}
		out = append(out, &slpb.StructField{
			Name:          f.Name,
			TargetSymbol:  f.Name,
			QualifiedName: t.Name + "." + f.Name,
		})
	}
	for _, e := range extras {
		if e == nil {
			continue
		}
		_, suffix, _ := splitNamespacePrefix(e.Name)
		out = append(out, &slpb.StructField{
			Name:          suffix,
			TargetSymbol:  suffix,
			QualifiedName: e.Name,
		})
	}
	return out
}

// valueForNonCallable carries the upstream type name (e.g. "string",
// "dict[string, Label]") into a Value's oneof so the frontend can render
// it as a type chip. Empty types produce an empty Value (oneof unset).
func valueForNonCallable(typeName string) *slpb.Value {
	if typeName == "" {
		return &slpb.Value{}
	}
	return &slpb.Value{
		Value: &slpb.Value_Type{Type: typeName},
	}
}

// returnInfo packages a Callable.return_type into a FunctionReturnInfo.
// FunctionReturnInfo has no dedicated type field, so we format the type
// name as `<type>`" inside doc_string — visible in the
// rendered docs without requiring a proto change. Returns nil if the type name is empty so the
// frontend can omit the section entirely.
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
			Name:         p.Name,
			DocString:    p.Doc,
			DefaultValue: p.DefaultValue,
			Mandatory:    p.IsMandatory,
			Role:         paramRole(p),
		})
	}
	return out
}

// paramsToAttributes flattens builtin.Param entries into stardoc
// AttributeInfo records for use as a Rule's attribute list. The upstream
// `Param.type` is a free-form string (e.g. "string", "Label", "List of Label")
// — we leave AttributeType unset (UNKNOWN); the frontend can still render
// the param/attribute name + doc + default + mandatory flag without it.
func paramsToAttributes(params []*builtinpb.Param) []*sdpb.AttributeInfo {
	out := make([]*sdpb.AttributeInfo, 0, len(params))
	for _, p := range params {
		out = append(out, &sdpb.AttributeInfo{
			Name:         p.Name,
			DocString:    p.Doc,
			DefaultValue: p.DefaultValue,
			Mandatory:    p.IsMandatory,
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
	case p.IsStarArg:
		return sdpb.FunctionParamRole_PARAM_ROLE_VARARGS
	case p.IsStarStarArg:
		return sdpb.FunctionParamRole_PARAM_ROLE_KWARGS
	default:
		return sdpb.FunctionParamRole_PARAM_ROLE_ORDINARY
	}
}

// decorateDoc prepends an ApiContext tag to the doc text when the symbol is
// restricted to BZL or BUILD scope, so consumers can see the constraint
// without an additional UI affordance. Cheap, lossy, but informative — a
// proper Symbol.api_context proto field is a future refinement.
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
