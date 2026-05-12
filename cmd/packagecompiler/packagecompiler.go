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
	toolName          = "packagecompiler"
	debugArgs         = false
	debugSandbox      = false
	failOnParseErrors = false
)

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

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
				return nil
			}
			return fmt.Errorf("reading work request: %v", err)
		}

		var resp wppb.WorkResponse
		resp.RequestId = req.RequestId

		batchCfg, err := parseConfig(req.Arguments)
		if err != nil {
			errMsg := fmt.Sprintf("parsing work request arguments: %v", err)
			persistentCfg.Logger.Println("ERROR:", errMsg)
			resp.Output = errMsg
			resp.ExitCode = 1
		} else {
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
				errMsg := fmt.Sprintf("performing work: %v", err)
				persistentCfg.Logger.Println("ERROR:", errMsg)
				resp.Output = errMsg
				resp.ExitCode = 1
			} else {
				resp.ExitCode = 0
			}
		}

		if err := protoutil.WriteDelimitedTo(&resp, os.Stdout); err != nil {
			return fmt.Errorf("writing work response: %v", err)
		}

		os.Stdout.Sync()
	}
}

func runBatch(cfg *config) error {
	now := time.Now()
	fail := func(err error) error {
		return fmt.Errorf("%v (%v)", err, time.Since(now))
	}

	packageFilesByPath, err := preparePackageFiles(cfg)
	if err != nil {
		return fail(err)
	}

	prepareShimBzlFiles(cfg)

	if debugSandbox {
		listFiles(cfg.Logger, filepath.Join(workDir, "external"))
	}

	result, err := extractModuleVersionPackages(cfg, packageFilesByPath, cfg.FilesToExtract)
	if err != nil {
		return fail(fmt.Errorf("failed to extract package info: %v", err))
	}

	if err := protoutil.WriteFile(cfg.OutputFile, result); err != nil {
		return fail(fmt.Errorf("failed to write output file: %v", err))
	}

	cfg.Logger.Printf("Completed in %v", time.Since(now))

	return nil
}
