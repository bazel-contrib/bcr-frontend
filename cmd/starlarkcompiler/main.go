package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/bazelbuild/bazel-gazelle/label"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
	"github.com/stackb/centrl/pkg/paramsfile"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	wppb "github.com/stackb/centrl/blaze/worker"
	"github.com/stackb/centrl/pkg/protoutil"
)

const toolName = "starlarkcompiler"

type Config struct {
	BuiltinsBzlPath     string
	Client              slpb.StarlarkBazelClient
	Cwd                 string
	JavaInterpreterFile string
	LogFile             string
	Logger              *log.Logger
	OutputFile          string
	PersistentWorker    bool
	Port                int
	ServerJarFile       string
	SourceFiles         []string
	WorkspaceCwd        string
	WorkspaceOutputBase string
}

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0) // don't print timestamps

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	log.Println("args:", args)
	listFiles(".")

	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	log.Println("parsedArgs:", parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to read params file: %v", err)
	}

	cfg, err := parseFlags(parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to parse args: %v", err)
	}

	// Validate required flags
	if cfg.JavaInterpreterFile == "" {
		return fmt.Errorf("--java_interpreter_file is required")
	}
	if cfg.ServerJarFile == "" {
		return fmt.Errorf("--server_jar_file is required")
	}
	if cfg.OutputFile == "" {
		return fmt.Errorf("--output_file is required")
	}
	if cfg.WorkspaceCwd == "" {
		return fmt.Errorf("--workspace_cwd is required")
	}
	if cfg.WorkspaceOutputBase == "" {
		return fmt.Errorf("--workspace_output_base is required")
	}

	wd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("getting os cwd: %v", err)
	} else {
		cfg.Cwd = wd
	}

	// Initialize logger
	if cfg.LogFile != "" {
		logFile, err := os.OpenFile(cfg.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
		if err != nil {
			return fmt.Errorf("failed to open log file: %v", err)
		}
		defer logFile.Close()
		cfg.Logger = log.New(logFile, toolName+": ", log.LstdFlags)
	} else {
		cfg.Logger = log.New(os.Stderr, toolName+": ", 0)
	}

	// Initialize gRPC client
	if cfg.Port == 0 {
		cfg.Port = mustGetFreePort()
	}
	conn, err := grpc.NewClient(
		fmt.Sprintf("localhost:%d", cfg.Port),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return fmt.Errorf("failed to create gRPC client: %v", err)
	}
	defer conn.Close()

	cfg.Client = slpb.NewStarlarkBazelClient(conn)

	if cfg.PersistentWorker {
		if err := persistentWork(&cfg); err != nil {
			return fmt.Errorf("while performing persistent work: %v", err)
		}
	} else {
		if err := batchWork(&cfg); err != nil {
			return fmt.Errorf("while performing batch work: %v", err)
		}
	}

	return nil
}

func persistentWork(cfg *Config) error {
	for {
		var req wppb.WorkRequest
		if err := protoutil.ReadDelimitedFrom(&req, os.Stdin); err != nil {
			if err == io.EOF {
				// this is the signal to terminate the program
				break
			}
			return fmt.Errorf("reading work request: %v", err)
		}

		var resp wppb.WorkResponse
		resp.RequestId = req.RequestId

		batchCfg, err := parseFlags(req.Arguments)
		if err != nil {
			return fmt.Errorf("parsing work request arguments: %v", err)
		}

		batchCfg.Client = cfg.Client
		batchCfg.Cwd = cfg.Cwd
		batchCfg.Logger = cfg.Logger

		if err := batchWork(&batchCfg); err != nil {
			return fmt.Errorf("performing persistent batch!: %v", err)
		}

		if err := protoutil.WriteDelimitedTo(&resp, os.Stdout); err != nil {
			return fmt.Errorf("writing work response: %v", err)
		}
	}
	return nil
}

func batchWork(cfg *Config) error {
	if cfg.OutputFile == "" {
		return fmt.Errorf("--output_file is required")
	}

	now := time.Now()
	fail := func(err error) error {
		return fmt.Errorf("%v (%v)", err, time.Since(now))
	}

	cfg.Logger.Printf("Processing %d source files", len(cfg.SourceFiles))

	result, err := extractModules(cfg)
	if err != nil {
		return fail(fmt.Errorf("failed to extract moddule info: %v", err))
	}

	if err := protoutil.WriteFile(cfg.OutputFile, result); err != nil {
		return fail(fmt.Errorf("failed to write output file: %v", err))
	}

	cfg.Logger.Printf("Completed in %v", time.Since(now))

	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.JavaInterpreterFile, "java_interpreter_file", "", "path to a java interpreter")
	fs.StringVar(&cfg.ServerJarFile, "server_jar_file", "", "the executable jar file for the server")
	fs.StringVar(&cfg.LogFile, "log_file", "", "path to log file (optional, defaults to stderr)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.WorkspaceCwd, "workspace_cwd", "", "the workspace root dir")
	fs.StringVar(&cfg.WorkspaceOutputBase, "workspace_output_base", "", "workspace output base")
	fs.IntVar(&cfg.Port, "port", 0, "the port number to use for the server process")
	fs.BoolVar(&cfg.PersistentWorker, "persistent_worker", false, "present if this tool is being invokes as a bazel persistent worker")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}
	cfg.SourceFiles = fs.Args()

	return
}

func extractModules(cfg *Config) (*slpb.ModuleInfoSet, error) {

	var result slpb.ModuleInfoSet

	for _, src := range cfg.SourceFiles {
		module, err := extractModule(cfg, src)
		if err != nil {
			return nil, err
		}
		result.Module = append(result.Module, module.Info)
	}

	return &result, nil
}

func extractModule(cfg *Config, src string) (*slpb.ModuleInfoResponse, error) {
	target, err := label.Parse(src)
	if err != nil {
		return nil, fmt.Errorf("invalid label: %v", err)
	}

	var content string

	request := &slpb.ModuleInfoRequest{
		TargetFileLabel:     target.String(),
		WorkspaceCwd:        cfg.WorkspaceCwd,
		WorkspaceOutputBase: cfg.WorkspaceOutputBase,
		Rel:                 target.Pkg,
		BuiltinsBzlPath:     cfg.BuiltinsBzlPath,
		ModuleContent:       content,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	response, err := cfg.Client.ModuleInfo(ctx, request)
	if err != nil {
		return nil, err
	}

	return response, nil
}

func mustGetFreePort() int {
	port, err := getFreePort()
	if err != nil {
		log.Panicf("Unable to determine free port: %v", err)
	}
	return port
}

func getFreePort() (int, error) {
	addr, err := net.ResolveTCPAddr("tcp", "localhost:0")
	if err != nil {
		return 0, err
	}

	l, err := net.ListenTCP("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// listFiles is a convenience debugging function to log the files under a given dir.
func listFiles(dir string) error {
	log.Println("Listing files under " + dir)
	return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Printf("%v\n", err)
			return err
		}
		log.Println(path)
		return nil
	})
}
