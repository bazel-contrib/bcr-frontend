package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
)

type stringList []string

func (s *stringList) String() string {
	return fmt.Sprintf("%v", *s)
}

func (s *stringList) Set(value string) error {
	*s = append(*s, value)
	return nil
}

type Config struct {
	URLs          stringList
	OutputFiles   stringList
	Timeout       time.Duration
	UseChromedp   bool
	ChromePath    string
	WaitReady     string
	WaitVisible   string
	Concurrency   int
	// Performance options
	DisableImages bool
	DisableCSS    bool
	DisableJS     bool
}

func main() {
	log.SetPrefix("statichtmlcompiler: ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return fmt.Errorf("failed to parse args: %w", err)
	}

	if len(cfg.URLs) == 0 {
		return fmt.Errorf("at least one --url is required")
	}

	if len(cfg.OutputFiles) != len(cfg.URLs) {
		return fmt.Errorf("number of --url and --output_file flags must match (got %d URLs and %d output files)", len(cfg.URLs), len(cfg.OutputFiles))
	}

	// Single URL mode
	if len(cfg.URLs) == 1 {
		return processSingleURL(cfg, cfg.URLs[0], cfg.OutputFiles[0])
	}

	// Batch mode
	return processBatch(cfg)
}

func processSingleURL(cfg Config, url, outputFile string) error {
	var content []byte
	var err error

	if cfg.UseChromedp {
		log.Printf("Rendering %s with chromedp", url)
		content, err = fetchWithChromedp(cfg, url)
		if err != nil {
			return fmt.Errorf("failed to render with chromedp: %w", err)
		}
	} else {
		log.Printf("Fetching %s with HTTP client", url)
		content, err = fetchWithHTTP(cfg, url)
		if err != nil {
			return fmt.Errorf("failed to fetch with HTTP: %w", err)
		}
	}

	// Write to output file
	if err := os.WriteFile(outputFile, content, 0644); err != nil {
		return fmt.Errorf("failed to write output file: %w", err)
	}

	log.Printf("Successfully wrote %d bytes to %s", len(content), outputFile)
	return nil
}

func processBatch(cfg Config) error {
	log.Printf("Processing %d URLs with concurrency %d", len(cfg.URLs), cfg.Concurrency)

	// Create semaphore for concurrency control
	sem := make(chan struct{}, cfg.Concurrency)
	var wg sync.WaitGroup
	errChan := make(chan error, len(cfg.URLs))

	// Shared Chrome allocator context for reuse
	var allocCtx context.Context
	var allocCancel context.CancelFunc

	if cfg.UseChromedp {
		ctx := context.Background()
		opts := buildChromedpOpts(cfg)
		allocCtx, allocCancel = chromedp.NewExecAllocator(ctx, opts...)
		defer allocCancel()
	}

	for i := range cfg.URLs {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()

			// Acquire semaphore
			sem <- struct{}{}
			defer func() { <-sem }()

			targetURL := cfg.URLs[index]
			outputFile := cfg.OutputFiles[index]

			log.Printf("[%d/%d] Processing %s -> %s", index+1, len(cfg.URLs), targetURL, outputFile)

			var content []byte
			var err error

			if cfg.UseChromedp {
				content, err = fetchWithChromedpShared(cfg, allocCtx, targetURL)
			} else {
				content, err = fetchWithHTTP(cfg, targetURL)
			}

			if err != nil {
				errChan <- fmt.Errorf("failed to process %s: %w", targetURL, err)
				return
			}

			// Ensure output directory exists
			dir := filepath.Dir(outputFile)
			if err := os.MkdirAll(dir, 0755); err != nil {
				errChan <- fmt.Errorf("failed to create directory %s: %w", dir, err)
				return
			}

			if err := os.WriteFile(outputFile, content, 0644); err != nil {
				errChan <- fmt.Errorf("failed to write %s: %w", outputFile, err)
				return
			}

			log.Printf("[%d/%d] Completed %s (%d bytes)", index+1, len(cfg.URLs), targetURL, len(content))
		}(i)
	}

	// Wait for all goroutines
	wg.Wait()
	close(errChan)

	// Collect errors
	var errors []error
	for err := range errChan {
		errors = append(errors, err)
	}

	if len(errors) > 0 {
		return fmt.Errorf("encountered %d errors: %v", len(errors), errors[0])
	}

	log.Printf("Successfully processed all %d URLs", len(cfg.URLs))
	return nil
}

func fetchWithHTTP(cfg Config, targetURL string) ([]byte, error) {
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: cfg.Timeout,
	}

	// Fetch the URL
	resp, err := client.Get(targetURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch URL: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP request failed with status: %d %s", resp.StatusCode, resp.Status)
	}

	// Read the response body
	content, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	return content, nil
}

func buildChromedpOpts(cfg Config) []chromedp.ExecAllocatorOption {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		// Performance optimizations
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-background-timer-throttling", true),
		chromedp.Flag("disable-backgrounding-occluded-windows", true),
		chromedp.Flag("disable-breakpad", true),
		chromedp.Flag("disable-component-extensions-with-background-pages", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-features", "TranslateUI,BlinkGenPropertyTrees"),
		chromedp.Flag("disable-ipc-flooding-protection", true),
		chromedp.Flag("disable-renderer-backgrounding", true),
		chromedp.Flag("enable-automation", true),
		chromedp.Flag("enable-features", "NetworkService,NetworkServiceInProcess"),
		chromedp.Flag("force-color-profile", "srgb"),
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("metrics-recording-only", true),
		chromedp.Flag("mute-audio", true),
		chromedp.Flag("no-first-run", true),
	)
	if cfg.ChromePath != "" {
		opts = append(opts, chromedp.ExecPath(cfg.ChromePath))
	}
	return opts
}

func fetchWithChromedp(cfg Config, targetURL string) ([]byte, error) {
	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	opts := buildChromedpOpts(cfg)
	allocCtx, allocCancel := chromedp.NewExecAllocator(ctx, opts...)
	defer allocCancel()

	return fetchWithChromedpShared(cfg, allocCtx, targetURL)
}

func fetchWithChromedpShared(cfg Config, allocCtx context.Context, targetURL string) ([]byte, error) {
	// Create timeout context
	ctx, cancel := context.WithTimeout(allocCtx, cfg.Timeout)
	defer cancel()

	// Create chromedp context (reuses the allocator)
	chromeCtx, chromeCancel := chromedp.NewContext(ctx)
	defer chromeCancel()

	var html string

	tasks := chromedp.Tasks{
		chromedp.Navigate(targetURL),
	}

	// Add wait conditions if specified
	if cfg.WaitReady != "" {
		tasks = append(tasks, chromedp.WaitReady(cfg.WaitReady))
	} else {
		// Default wait for body
		tasks = append(tasks, chromedp.WaitReady("body"))
	}

	if cfg.WaitVisible != "" {
		tasks = append(tasks, chromedp.WaitVisible(cfg.WaitVisible))
	}

	// Get the rendered HTML
	tasks = append(tasks, chromedp.OuterHTML("html", &html))

	err := chromedp.Run(chromeCtx, tasks)
	if err != nil {
		return nil, fmt.Errorf("chromedp run failed: %w", err)
	}

	return []byte(html), nil
}

func parseFlags(args []string) (cfg Config, err error) {
	var timeoutSec int

	fs := flag.NewFlagSet("statichtmlcompiler", flag.ExitOnError)
	fs.Var(&cfg.URLs, "url", "URL to fetch (repeatable)")
	fs.Var(&cfg.OutputFiles, "output_file", "output file to write (repeatable, must match --url count)")
	fs.IntVar(&timeoutSec, "timeout", 30, "timeout in seconds (default: 30)")
	fs.IntVar(&cfg.Concurrency, "concurrency", 4, "number of concurrent workers for batch mode")
	fs.BoolVar(&cfg.UseChromedp, "chromedp", true, "use chromedp to render JavaScript (requires Chrome/Chromium)")
	fs.StringVar(&cfg.ChromePath, "chrome_path", "", "path to Chrome/Chromium binary (default: search $PATH)")
	fs.StringVar(&cfg.WaitReady, "wait_ready", "", "CSS selector to wait for (e.g., 'body', '.content')")
	fs.StringVar(&cfg.WaitVisible, "wait_visible", "", "CSS selector to wait until visible")
	fs.BoolVar(&cfg.DisableImages, "disable_images", true, "disable image loading for faster rendering")
	fs.BoolVar(&cfg.DisableCSS, "disable_css", false, "disable CSS loading (not recommended for SPAs)")
	fs.BoolVar(&cfg.DisableJS, "disable_js", false, "disable JavaScript (not recommended for SPAs)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: statichtmlcompiler [options]\n\nExamples:\n")
		fmt.Fprintf(flag.CommandLine.Output(), "  Single URL:\n")
		fmt.Fprintf(flag.CommandLine.Output(), "    statichtmlcompiler --url=http://localhost:8080 --output_file=index.html\n\n")
		fmt.Fprintf(flag.CommandLine.Output(), "  Multiple URLs (batch):\n")
		fmt.Fprintf(flag.CommandLine.Output(), "    statichtmlcompiler --url=http://localhost/page1 --output_file=page1.html \\\n")
		fmt.Fprintf(flag.CommandLine.Output(), "                       --url=http://localhost/page2 --output_file=page2.html \\\n")
		fmt.Fprintf(flag.CommandLine.Output(), "                       --concurrency=8\n\n")
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	cfg.Timeout = time.Duration(timeoutSec) * time.Second
	return
}
