package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"

	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"

	wppb "github.com/bazel-contrib/bcr-frontend/blaze/worker"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const (
	toolName          = "bzlcompiler"
	debugArgs         = false
	debugSandbox      = false
	debugRewrites     = false
	failOnParseErrors = false
)

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0) // don't print timestamps

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	if debugArgs {
		log.Println("args:", args)
	}
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	if err != nil {
		return fmt.Errorf("failed to read params file: %v", err)
	}
	if debugArgs {
		for _, arg := range parsedArgs {
			log.Println("parsedArg:", arg)
		}
	}

	cfg, err := parseConfig(parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to parse args: %v", err)
	}

	if cfg.PersistentWorker {
		if err := runPersistent(cfg); err != nil {
			return fmt.Errorf("while performing persistent work: %v", err)
		}
		cfg.Logger.Println("Received EOF, shutting down persistent worker")
	} else {
		// Initialize server and gRPC client for batch work
		resources, cleanup, err := initializeServer(cfg.JavaInterpreterFile, cfg.ServerJarFile, cfg.Port, cfg.LogFile, cfg.Logger)
		if err != nil {
			return fmt.Errorf("failed to initialize server: %v", err)
		}
		cfg.Logger.Println("Server ready")
		defer cleanup()

		cfg.Client = slpb.NewStarlarkClient(resources.conn)

		if err := runBatch(cfg); err != nil {
			return fmt.Errorf("while performing batch work: %v", err)
		}
	}

	return nil
}

func runPersistent(persistentCfg *config) error {
	var resources *serverResources

	for {
		var req wppb.WorkRequest
		if err := protoutil.ReadDelimitedFrom(&req, os.Stdin); err != nil {
			if err == io.EOF {
				// this is the signal to terminate the program
				return nil
			}
			return fmt.Errorf("reading work request: %v", err)
		}

		var resp wppb.WorkResponse
		resp.RequestId = req.RequestId

		batchCfg, err := parseConfig(req.Arguments)
		if err != nil {
			// Don't kill the worker on parse errors - report error and continue
			errMsg := fmt.Sprintf("parsing work request arguments: %v", err)
			persistentCfg.Logger.Println("ERROR:", errMsg)
			resp.Output = errMsg
			resp.ExitCode = 1
		} else {
			// Start server on first request
			if resources == nil {
				r, cleanup, err := initializeServer(batchCfg.JavaInterpreterFile, batchCfg.ServerJarFile, batchCfg.Port, batchCfg.LogFile, persistentCfg.Logger)
				if err != nil {
					errMsg := fmt.Sprintf("failed to initialize server: %v", err)
					batchCfg.Logger.Println("ERROR:", errMsg)
					resp.Output = errMsg
					resp.ExitCode = 1
					if err := protoutil.WriteDelimitedTo(&resp, os.Stdout); err != nil {
						return fmt.Errorf("writing work response: %v", err)
					}
					os.Stdout.Sync()
					continue
				}
				resources = r
				defer cleanup()
				persistentCfg.Port = r.port
				persistentCfg.Client = slpb.NewStarlarkClient(resources.conn)
				persistentCfg.Logger.Println("Server ready")
			}

			batchCfg.Logger = persistentCfg.Logger
			batchCfg.Cwd = persistentCfg.Cwd
			batchCfg.Port = persistentCfg.Port
			batchCfg.Client = persistentCfg.Client

			if err := runBatch(batchCfg); err != nil {
				// Don't kill the worker on work errors - report error and continue
				errMsg := fmt.Sprintf("performing work: %v", err)
				persistentCfg.Logger.Println("ERROR:", errMsg)
				resp.Output = errMsg
				resp.ExitCode = 1
			} else {
				// Success
				resp.ExitCode = 0
			}
		}

		if err := protoutil.WriteDelimitedTo(&resp, os.Stdout); err != nil {
			return fmt.Errorf("writing work response: %v", err)
		}

		// Flush stdout to ensure Bazel receives the response immediately
		os.Stdout.Sync()
	}
}

func runBatch(cfg *config) error {
	now := time.Now()
	fail := func(err error) error {
		return fmt.Errorf("%v (%v)", err, time.Since(now))
	}

	bzlFilesByPath, err := prepareBzlFiles(cfg, cfg.BzlFiles)
	if err != nil {
		return fail(err)
	}

	prepareShimBzlFiles(cfg)

	if debugSandbox {
		listFiles(cfg.Logger, filepath.Join(workDir, "external"))
	}

	result, err := extractModuleVersionSymbols(cfg, bzlFilesByPath, cfg.FilesToExtract)
	if err != nil {
		return fail(fmt.Errorf("failed to extract module info: %v", err))
	}

	if err := protoutil.WriteFile(cfg.OutputFile, result); err != nil {
		return fail(fmt.Errorf("failed to write output file: %v", err))
	}

	cfg.Logger.Printf("Completed in %v", time.Since(now))

	return nil
}
