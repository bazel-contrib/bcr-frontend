package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/bazel-contrib/bcr-frontend/pkg/cf"
)

func main() {
	log.SetPrefix("cfdeploy: ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	// Parse subcommand
	switch os.Args[1] {
	case "worker":
		deployWorker(os.Args[2:])
	case "-h", "--help", "help":
		printUsage()
	default:
		// Default to worker deployment
		deployWorker(os.Args[1:])
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "Deploy Cloudflare Workers with static assets\n\n")
	fmt.Fprintf(os.Stderr, "Environment Variables:\n")
	fmt.Fprintf(os.Stderr, "  CLOUDFLARE_API_TOKEN    Cloudflare API token\n")
	fmt.Fprintf(os.Stderr, "  CF_ACCOUNT_ID           Cloudflare account ID\n")
	fmt.Fprintf(os.Stderr, "\nExamples:\n")
	fmt.Fprintf(os.Stderr, "  # Deploy assets-only worker\n")
	fmt.Fprintf(os.Stderr, "  %s --name=my-site --assets=./public\n\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  # Deploy worker with custom script and assets\n")
	fmt.Fprintf(os.Stderr, "  %s --name=my-worker --script=worker.js --assets=./public\n", os.Args[0])
}

func getCredentials(apiToken, accountID *string) (string, string) {
	// Get credentials from flags or environment
	token := *apiToken
	if token == "" {
		token = os.Getenv("CLOUDFLARE_API_TOKEN")
	}
	if token == "" {
		log.Fatal("API token required (use --api_token or CLOUDFLARE_API_TOKEN env var)")
	}

	acctID := *accountID
	if acctID == "" {
		acctID = os.Getenv("CF_ACCOUNT_ID")
	}
	if acctID == "" {
		log.Fatal("Account ID required (use --account_id or CF_ACCOUNT_ID env var)")
	}

	return token, acctID
}

func deployWorker(args []string) {
	fs := flag.NewFlagSet("worker", flag.ExitOnError)

	var (
		apiToken          = fs.String("api_token", "", "Cloudflare API token (or set CLOUDFLARE_API_TOKEN env var)")
		accountID         = fs.String("account_id", "", "Cloudflare account ID (or set CF_ACCOUNT_ID env var)")
		name              = fs.String("name", "", "Worker script name")
		script            = fs.String("script", "", "Path to Worker script file")
		assets            = fs.String("assets", "", "Path to assets directory (optional)")
		compatibilityDate = fs.String("compatibility_date", "", "Compatibility date (e.g., 2024-01-01)")
		wasmModules       = fs.String("wasm_modules", "", "Comma-separated list of WASM/JS module paths")
	)

	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: %s worker [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Deploy a Cloudflare Worker with optional assets.\n\n")
		fmt.Fprintf(os.Stderr, "Options:\n")
		fs.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExample:\n")
		fmt.Fprintf(os.Stderr, "  %s worker --name=my-worker --script=worker.js --assets=./public --compatibility_date=2024-01-01\n", os.Args[0])
	}

	fs.Parse(args)

	token, acctID := getCredentials(apiToken, accountID)

	if *name == "" {
		log.Fatal("Worker name required (use --name)")
	}

	// Script is optional if assets are provided (assets-only deployment)
	if *script != "" {
		// Check if script exists
		if _, err := os.Stat(*script); os.IsNotExist(err) {
			log.Fatalf("Worker script not found: %s", *script)
		}
	}

	// Create Cloudflare client
	client := cf.NewClient(token, acctID)
	client.SetLogger(log.Default())

	options := cf.WorkerDeployOptions{
		CompatibilityDate: *compatibilityDate,
	}

	// Parse WASM modules
	var modules []string
	if *wasmModules != "" {
		for _, m := range strings.Split(*wasmModules, ",") {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}

			// Check file extension
			ext := filepath.Ext(m)
			if ext != ".wasm" && ext != ".js" && ext != ".mjs" {
				log.Printf("Skipping non-WASM/JS file: %s", m)
				continue
			}

			// Verify module exists
			if _, err := os.Stat(m); os.IsNotExist(err) {
				log.Fatalf("WASM/JS module not found: %s", m)
			}

			modules = append(modules, m)
		}
	}

	var deployment *cf.WorkerDeployment
	var err error

	if *assets != "" {
		// Check if assets directory exists
		if info, err := os.Stat(*assets); os.IsNotExist(err) {
			log.Fatalf("Assets directory not found: %s", *assets)
		} else if !info.IsDir() {
			log.Fatalf("Assets path is not a directory: %s", *assets)
		}

		// If no script provided, deploy assets-only
		if *script == "" {
			log.Printf("Deploying assets-only Worker %s from %s...", *name, *assets)
			deployment, err = client.DeployAssetsOnly(*name, *assets, options)
		} else {
			log.Printf("Deploying Worker %s with assets from %s...", *name, *assets)
			deployment, err = client.DeployWorkerWithAssets(*name, *script, *assets, modules, options)
		}
	} else {
		if *script == "" {
			log.Fatal("Either --script or --assets must be provided")
		}
		log.Printf("Deploying Worker %s...", *name)
		deployment, err = client.DeployWorker(*name, *script, options)
	}

	if err != nil {
		log.Fatalf("Failed to deploy worker: %v", err)
	}

	log.Printf("✓ Worker deployed successfully!")
	log.Printf("  Name:               %s", deployment.ScriptName)
	log.Printf("  ID:                 %s", deployment.ID)
	log.Printf("  Compatibility Date: %s", deployment.CompatibilityDate)
	log.Printf("  Worker URL:         https://%s.<subdomain>.workers.dev", *name)
}
