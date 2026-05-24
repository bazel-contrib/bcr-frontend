// Command builtinsmerger combines two ModuleVersionSymbols protos into one:
//
//   - --builtins_file: the upstream builtin.Builtins reshape from
//     cmd/builtinscompiler. Covers every globally-available symbol but
//     carries only thin attribute info (name, doc, mandatory, default) with
//     no Starlark AttributeType.
//
//   - --bzlsrc_file: the constellate output from running stardoc over the
//     Bazel source tree's src/main/starlark/builtins_bzl/ directory. Has
//     fully-typed Rule.info.attribute entries for the rules it can extract.
//
// The merge is a name-keyed "left join" anchored on builtins. For each
// builtins symbol whose name matches a bzl_src symbol of the same
// SymbolType, we swap in the bzl_src Symbol.Info payload (Rule, Function,
// Provider, …) — preserving the builtins side's `name`, `type`,
// `display_name`, and ApiContext-decorated description prefix. The
// merged result is the union of fields favoring richness from bzl_src.
//
// Symbols present in bzl_src but not in builtins are dropped. They're
// typically private helpers from the Bazel source tree that aren't part of
// the public builtin surface.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
	sdpb "github.com/bazel-contrib/bcr-frontend/stardoc_output"
)

const toolName = "builtinsmerger"

type config struct {
	builtinsFile string
	bzlsrcFile   string
	outputFile   string
	// onlyNames, when non-empty, restricts enrichment to symbols whose name
	// is in the set. Other symbols pass through unchanged from the builtins
	// side. Empty set means "enrich everything that matches".
	onlyNames stringSet
}

type stringSet map[string]bool

func (s *stringSet) String() string {
	if s == nil || len(*s) == 0 {
		return ""
	}
	out := make([]string, 0, len(*s))
	for k := range *s {
		out = append(out, k)
	}
	return strings.Join(out, ",")
}

func (s *stringSet) Set(v string) error {
	if *s == nil {
		*s = stringSet{}
	}
	(*s)[v] = true
	return nil
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

	var builtins sympb.ModuleVersionSymbols
	if err := protoutil.ReadFile(cfg.builtinsFile, &builtins); err != nil {
		return fmt.Errorf("reading %s: %v", cfg.builtinsFile, err)
	}

	var bzlsrc sympb.ModuleVersionSymbols
	if err := protoutil.ReadFile(cfg.bzlsrcFile, &bzlsrc); err != nil {
		return fmt.Errorf("reading %s: %v", cfg.bzlsrcFile, err)
	}

	merged := merge(&builtins, &bzlsrc, cfg.onlyNames)

	if err := protoutil.WriteFile(cfg.outputFile, merged); err != nil {
		return fmt.Errorf("writing %s: %v", cfg.outputFile, err)
	}
	return nil
}

func parseFlags(args []string) (config, error) {
	var cfg config
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.builtinsFile, "builtins_file", "", "ModuleVersionSymbols .pb from cmd/builtinscompiler (thin, complete)")
	fs.StringVar(&cfg.bzlsrcFile, "bzlsrc_file", "", "ModuleVersionSymbols .pb from cmd/bzlcompiler over the bzl_src tree (rich, partial)")
	fs.StringVar(&cfg.outputFile, "output_file", "", "output path for the merged ModuleVersionSymbols .pb")
	fs.Var(&cfg.onlyNames, "only_name", "restrict enrichment to this symbol name (repeatable). Empty = enrich every match.")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	if cfg.builtinsFile == "" {
		return cfg, fmt.Errorf("--builtins_file is required")
	}
	if cfg.bzlsrcFile == "" {
		return cfg, fmt.Errorf("--bzlsrc_file is required")
	}
	if cfg.outputFile == "" {
		return cfg, fmt.Errorf("--output_file is required")
	}
	return cfg, nil
}

// merge produces a ModuleVersionSymbols that uses builtins as the backbone,
// enriched with bzl_src-extracted attribute/parameter type info where names
// match. When onlyNames is non-empty, only symbols whose name is in the
// set get considered for enrichment (others pass through unchanged). The
// returned proto is the same instance as builtins (mutated in place);
// callers should not retain a reference to the original.
//
// IMPORTANT: the merge is per-attribute/per-parameter, NOT a wholesale
// Symbol.Info swap. The builtins side has the COMPLETE list of params/attrs
// for every callable (because builtin.pb covers them exhaustively); the
// bzl_src side has rich TYPE info but may have a smaller (or empty)
// attribute list because constellate can't always fully parse complex
// native rules like objc_library. Wholesale-swapping the Info payload
// would replace a complete-but-thin attribute list with an empty-but-rich
// one, dropping the attributes entirely. Per-field enrichment keeps the
// completeness and adds the type info opportunistically.
func merge(builtins, bzlsrc *sympb.ModuleVersionSymbols, onlyNames stringSet) *sympb.ModuleVersionSymbols {
	bzlsrcByName := make(map[string]*sympb.Symbol)
	for _, f := range bzlsrc.GetFile() {
		for _, sym := range f.GetSymbol() {
			if sym.GetName() == "" {
				continue
			}
			bzlsrcByName[sym.GetName()] = sym
			if strings.Contains(sym.Name, "objc_library") {
				log.Printf("bzlsrcByName[%s]: %+v", sym.Name, sym)
			}
		}
	}

	enriched := 0
	for _, f := range builtins.GetFile() {
		for _, sym := range f.GetSymbol() {
			if len(onlyNames) > 0 && !onlyNames[sym.GetName()] {
				continue
			}
			rich, ok := bzlsrcByName[sym.GetName()]
			if !ok {
				continue
			}
			// Same SymbolType on both sides — otherwise the kind chip would
			// disagree with the payload after enrichment.
			if rich.GetType() != sym.GetType() {
				continue
			}
			if enrichSymbol(sym, rich) {
				enriched++
			}
		}
	}
	if len(onlyNames) > 0 {
		log.Printf("enriched %d symbols (gated to %d names) from %d bzl_src entries", enriched, len(onlyNames), len(bzlsrcByName))
	} else {
		log.Printf("enriched %d symbols from %d bzl_src entries", enriched, len(bzlsrcByName))
	}
	return builtins
}

// enrichSymbol enriches a builtins-side Symbol in place with field-level
// info from a matching bzl_src Symbol. Returns true when at least one field
// got enriched. Currently supports RULE (Rule.info.attribute +
// Rule.attribute) and FUNCTION (Function.info.parameter) symbols; other
// kinds short-circuit with a description-level merge only.
func enrichSymbol(sym, rich *sympb.Symbol) bool {
	changed := false
	switch sym.GetType() {
	case sympb.SymbolType_SYMBOL_TYPE_RULE:
		if rich.GetRule() != nil && sym.GetRule() != nil {
			if enrichRule(sym.GetRule(), rich.GetRule()) {
				changed = true
			}
		}
	case sympb.SymbolType_SYMBOL_TYPE_FUNCTION:
		if rich.GetFunc() != nil && sym.GetFunc() != nil {
			if enrichFunction(sym.GetFunc(), rich.GetFunc()) {
				changed = true
			}
		}
	}
	if newDesc := mergeDescription(sym.GetDescription(), rich.GetDescription()); newDesc != sym.GetDescription() {
		sym.Description = newDesc
		changed = true
	}
	return changed
}

// enrichRule fills in stardoc AttributeType, attribute doc_string, and
// provider_name_group info on a builtins-side Rule from a matching bzl_src
// Rule. The builtins-side attribute list (which is complete) is preserved
// in its original order; the bzl_src side acts as a lookup table.
func enrichRule(dst, src *slpb.Rule) bool {
	srcByName := indexAttributes(src.GetInfo().GetAttribute())
	changed := enrichAttributeInfoList(dst.GetInfo().GetAttribute(), srcByName)
	// Rule.attribute is a parallel list of slpb.Attribute wrappers; each
	// embeds an AttributeInfo. Enrich those too so renderers that read from
	// either source pick up the type info.
	for _, a := range dst.GetAttribute() {
		if rich, ok := srcByName[a.GetInfo().GetName()]; ok {
			if enrichAttributeInfo(a.GetInfo(), rich) {
				changed = true
			}
		}
	}
	return changed
}

func indexAttributes(attrs []*sdpb.AttributeInfo) map[string]*sdpb.AttributeInfo {
	out := make(map[string]*sdpb.AttributeInfo, len(attrs))
	for _, a := range attrs {
		if a.GetName() != "" {
			out[a.GetName()] = a
		}
	}
	return out
}

func enrichAttributeInfoList(dst []*sdpb.AttributeInfo, srcByName map[string]*sdpb.AttributeInfo) bool {
	changed := false
	for _, a := range dst {
		if rich, ok := srcByName[a.GetName()]; ok {
			if enrichAttributeInfo(a, rich) {
				changed = true
			}
		}
	}
	return changed
}

// enrichAttributeInfo copies opportunistically. The builtins-side fields
// the upstream proto sets (name, mandatory, default_value) are kept because
// they reflect Bazel's runtime reality. The bzl_src side fills in fields
// the builtins reshape can't compute (type enum, rich doc_string, provider
// constraints, nonconfigurable flag).
func enrichAttributeInfo(dst, src *sdpb.AttributeInfo) bool {
	changed := false
	if dst.GetType() == sdpb.AttributeType_UNKNOWN && src.GetType() != sdpb.AttributeType_UNKNOWN {
		dst.Type = src.Type
		changed = true
	}
	if dst.GetDocString() == "" && src.GetDocString() != "" {
		dst.DocString = src.DocString
		changed = true
	}
	if len(dst.GetProviderNameGroup()) == 0 && len(src.GetProviderNameGroup()) > 0 {
		dst.ProviderNameGroup = src.ProviderNameGroup
		changed = true
	}
	if !dst.GetNonconfigurable() && src.GetNonconfigurable() {
		dst.Nonconfigurable = true
		changed = true
	}
	if !dst.GetNativelyDefined() && src.GetNativelyDefined() {
		dst.NativelyDefined = true
		changed = true
	}
	return changed
}

// enrichFunction mirrors enrichRule for callables: enriches each builtins-
// side FunctionParamInfo with bzl_src docstring and role info, preserving
// the complete parameter list from builtins.
func enrichFunction(dst, src *slpb.Function) bool {
	srcByName := make(map[string]*sdpb.FunctionParamInfo)
	for _, p := range src.GetInfo().GetParameter() {
		if p.GetName() != "" {
			srcByName[p.GetName()] = p
		}
	}
	changed := false
	for _, p := range dst.GetInfo().GetParameter() {
		rich, ok := srcByName[p.GetName()]
		if !ok {
			continue
		}
		if p.GetDocString() == "" && rich.GetDocString() != "" {
			p.DocString = rich.DocString
			changed = true
		}
		if p.GetRole() == sdpb.FunctionParamRole_PARAM_ROLE_UNSPECIFIED && rich.GetRole() != sdpb.FunctionParamRole_PARAM_ROLE_UNSPECIFIED {
			p.Role = rich.Role
			changed = true
		}
	}
	return changed
}

// mergeDescription preserves the ApiContext prefix tag (e.g. "[BUILD only] ")
// from the builtins-side description, then appends the bzl_src docstring.
// The builtins prefix is kept because it carries semantic info that the
// bzl_src side never knows about; the body after the prefix gets replaced
// since the bzl_src docstring is richer and usually has the full text.
func mergeDescription(builtinsDesc, bzlsrcDesc string) string {
	if bzlsrcDesc == "" {
		return builtinsDesc
	}
	prefix := apiContextPrefix(builtinsDesc)
	if prefix == "" {
		return bzlsrcDesc
	}
	return prefix + " " + bzlsrcDesc
}

// apiContextPrefix returns the leading "[BUILD only]" or "[.bzl only]" tag
// from a builtins-side description if present, otherwise "". Mirrors the
// decorations applied by cmd/builtinscompiler's decorateDoc helper.
func apiContextPrefix(desc string) string {
	for _, tag := range []string{"[BUILD only]", "[.bzl only]"} {
		if strings.HasPrefix(desc, tag) {
			return tag
		}
	}
	return ""
}
