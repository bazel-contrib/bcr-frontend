// Command builtininfocompiler queries constellate's BuiltinInfo RPC and
// reshapes the response into a ModuleVersionSymbols.pb suitable for the
// @_builtins pseudo-module's documentation pipeline.
//
// The RPC returns two complementary forms in a single call:
//
//   - `builtins`: the upstream builtin.Builtins proto. Covers every
//     globally-available symbol but carries only thin attribute info
//     (name, doc, mandatory, default) with no Starlark AttributeType.
//
//   - `module_info[]` + `module_info_source[]`: six rich stardoc_output
//     ModuleInfo protos (cpp, java, objc, proto, python, shell) each
//     carrying full RuleInfo + AttributeInfo for the Starlark-defined
//     rules in one language module.
//
// Reshape + enrichment happen in one pass: the complete-but-thin
// attribute list from builtin.Builtins is preserved verbatim and
// individual attributes get their AttributeType + rich doc backfilled
// from the matching ModuleInfo entry when one exists.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const toolName = "builtininfocompiler"

type config struct {
	outputFile          string
	javaInterpreterFile string
	serverJarFile       string
	port                int
	logFile             string
	logger              *log.Logger
	// onlyNames, when non-empty, restricts attribute enrichment to symbols
	// whose name is in the set. Other symbols pass through with only the
	// builtin.pb-derived attribute info. Empty set = enrich every match.
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
	// Expand any @params_file references — Bazel's args.use_param_file
	// passes the entire flag list via a side file.
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	if err != nil {
		return fmt.Errorf("reading params file: %v", err)
	}
	cfg, err := parseFlags(parsedArgs)
	if err != nil {
		return err
	}

	resources, cleanup, err := initializeServer(cfg.javaInterpreterFile, cfg.serverJarFile, cfg.port, cfg.logFile, cfg.logger)
	if err != nil {
		return fmt.Errorf("failed to initialize server: %v", err)
	}
	defer cleanup()
	cfg.logger.Println("Server ready")

	client := slpb.NewStarlarkClient(resources.conn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	resp, err := client.BuiltinInfo(ctx, &slpb.BuiltinInfoRequest{})
	if err != nil {
		return fmt.Errorf("BuiltinInfo RPC failed: %v", err)
	}
	if resp.GetBuiltins() == nil {
		return fmt.Errorf("BuiltinInfoResponse has no builtins field")
	}
	cfg.logger.Printf("Got BuiltinInfo: %d types, %d globals, %d module_infos",
		len(resp.GetBuiltins().GetType()),
		len(resp.GetBuiltins().GetGlobal()),
		len(resp.GetModuleInfo()))

	mvs := reshape(resp, cfg.onlyNames)

	if err := protoutil.WriteFile(cfg.outputFile, mvs); err != nil {
		return fmt.Errorf("writing %s: %v", cfg.outputFile, err)
	}
	return nil
}

func parseFlags(args []string) (*config, error) {
	cfg := &config{}
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.outputFile, "output_file", "", "path to write the output ModuleVersionSymbols .pb")
	fs.StringVar(&cfg.javaInterpreterFile, "java_interpreter_file", "", "path to a java interpreter")
	fs.StringVar(&cfg.serverJarFile, "server_jar_file", "", "the executable jar file for the constellate server")
	fs.IntVar(&cfg.port, "port", 0, "if non-zero, connect to an externally-running constellate at this port (skip jar startup)")
	fs.StringVar(&cfg.logFile, "log_file", "", "log-file prefix (server logs go to <prefix>.server.log)")
	fs.Var(&cfg.onlyNames, "only_name", "restrict attribute enrichment to this symbol name (repeatable). Empty = enrich every match.")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if cfg.outputFile == "" {
		return nil, fmt.Errorf("--output_file is required")
	}
	if cfg.port == 0 {
		if cfg.javaInterpreterFile == "" {
			return nil, fmt.Errorf("--java_interpreter_file is required when --port is 0")
		}
		if cfg.serverJarFile == "" {
			return nil, fmt.Errorf("--server_jar_file is required when --port is 0")
		}
	}

	cfg.logger = log.New(os.Stderr, toolName+": ", log.LstdFlags|log.Lshortfile)
	return cfg, nil
}
