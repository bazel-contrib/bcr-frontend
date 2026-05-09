package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
	SingleContext bool
	SettleDelay   time.Duration
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

	// Batch with shared chromedp tab(s) — each worker keeps one tab and
	// navigates SPA-style via pushState+popstate. Much faster for SPA routes.
	if cfg.SingleContext && cfg.UseChromedp {
		return processBatchSingleContext(cfg)
	}

	// Batch mode (one chromedp tab per URL)
	return processBatch(cfg)
}

// prerenderMetaAction injects <meta name="bcr:prerendered-path" content="<path>">
// into <head> just before the snapshot is captured. The path is the URL
// pathname (no scheme/host), normalized so trailing slashes match — i.e.
// "/" stays "/", everything else has trailing slashes stripped. The early
// inline script in index.html reads this meta to decide whether to hide the
// route-specific .content panel until the SPA has mounted.
func prerenderMetaAction(targetURL string) chromedp.Action {
	path := normalizePrerenderPath(targetURL)
	js := fmt.Sprintf(`(function () {
  var existing = document.querySelector('meta[name="bcr:prerendered-path"]');
  if (existing) existing.remove();
  var m = document.createElement('meta');
  m.setAttribute('name', 'bcr:prerendered-path');
  m.setAttribute('content', %q);
  document.head.appendChild(m);
})();`, path)
	return chromedp.Evaluate(js, nil)
}

func normalizePrerenderPath(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Path == "" {
		return "/"
	}
	p := u.Path
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	return p
}

// writeRenderedHTML writes content to every path in outputSpec, where
// outputSpec is a comma-separated list (e.g. "a/index.html,b/index.html").
// Used so a single chromedp render can fan out to both the canonical and
// alias paths (e.g. /modules/foo/2.6.1 and /modules/foo) without
// re-rendering. Single-path values still work: "foo.html" -> ["foo.html"].
func writeRenderedHTML(outputSpec string, content []byte) error {
	for _, raw := range strings.Split(outputSpec, ",") {
		path := strings.TrimSpace(raw)
		if path == "" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return fmt.Errorf("create dir for %s: %w", path, err)
		}
		if err := os.WriteFile(path, content, 0644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	}
	return nil
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

	// Write to output file(s) — outputFile may be a comma-separated list.
	if err := writeRenderedHTML(outputFile, content); err != nil {
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

			// outputFile may be a comma-separated list; writeRenderedHTML
			// fans out a single render to all paths (and mkdirs each).
			if err := writeRenderedHTML(outputFile, content); err != nil {
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

// processBatchSingleContext renders all URLs across N workers, each holding
// one chromedp tab. The first URL in each worker is a full Navigate (the SPA
// loads and parses REGISTRY_DATA once); subsequent URLs are dispatched as
// SPA navigations via history.pushState + popstate, avoiding page reloads.
//
// Requires: cfg.UseChromedp = true, len(cfg.URLs) >= 1.
func processBatchSingleContext(cfg Config) error {
	workers := cfg.Concurrency
	if workers < 1 {
		workers = 1
	}
	if workers > len(cfg.URLs) {
		workers = len(cfg.URLs)
	}
	chunkSize := (len(cfg.URLs) + workers - 1) / workers

	log.Printf("Single-context batch: %d URLs, %d workers, ~%d URLs/worker", len(cfg.URLs), workers, chunkSize)

	var wg sync.WaitGroup
	errChan := make(chan error, len(cfg.URLs))
	startedAt := time.Now()

	for w := 0; w < workers; w++ {
		startIdx := w * chunkSize
		endIdx := startIdx + chunkSize
		if endIdx > len(cfg.URLs) {
			endIdx = len(cfg.URLs)
		}
		if startIdx >= endIdx {
			break
		}

		wg.Add(1)
		go func(workerID, start, end int) {
			defer wg.Done()
			if err := runWorkerSingleContext(cfg, workerID, start, end); err != nil {
				errChan <- err
			}
		}(w, startIdx, endIdx)
	}

	wg.Wait()
	close(errChan)

	var errors []error
	for err := range errChan {
		errors = append(errors, err)
	}
	if len(errors) > 0 {
		return fmt.Errorf("encountered %d errors: %v", len(errors), errors[0])
	}

	log.Printf("Single-context batch: rendered %d URLs in %v", len(cfg.URLs), time.Since(startedAt))
	return nil
}

func runWorkerSingleContext(cfg Config, workerID, start, end int) error {
	opts := buildChromedpOpts(cfg)
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()

	// One chromedp tab for the whole worker. Running multiple chromedp.Run
	// calls against the same context is the supported pattern; wrapping each
	// Run in context.WithTimeout(chromeCtx, ...) is NOT — chromedp associates
	// session state with the deepest chromedp.Context in the chain, and
	// canceling the timeout context propagates "context canceled" back into
	// chromedp's Target loop on subsequent calls.
	chromeCtx, chromeCancel := chromedp.NewContext(allocCtx)
	defer chromeCancel()

	for i := start; i < end; i++ {
		targetURL := cfg.URLs[i]
		outputFile := cfg.OutputFiles[i]

		// First URL per worker: full Navigate (loads SPA, parses 2.7MB
		// REGISTRY_DATA once). Subsequent URLs: history.pushState +
		// popstate triggers the SPA's history listener and routes
		// without a page reload.
		var html string
		var tasks chromedp.Tasks
		if i == start {
			tasks = chromedp.Tasks{
				chromedp.Navigate(targetURL),
				chromedp.WaitReady("body"),
				chromedp.Sleep(cfg.SettleDelay),
				prerenderMetaAction(targetURL),
				chromedp.OuterHTML("html", &html),
			}
		} else {
			js := fmt.Sprintf(
				`window.history.pushState({}, '', %q); window.dispatchEvent(new PopStateEvent('popstate', {state: {}}));`,
				targetURL,
			)
			tasks = chromedp.Tasks{
				chromedp.Evaluate(js, nil),
				chromedp.Sleep(cfg.SettleDelay),
				prerenderMetaAction(targetURL),
				chromedp.OuterHTML("html", &html),
			}
		}

		stepStart := time.Now()
		if err := chromedp.Run(chromeCtx, tasks); err != nil {
			return fmt.Errorf("worker %d: failed on %s: %w", workerID, targetURL, err)
		}

		// outputFile may be a comma-separated list of paths; fan out the
		// single rendered HTML to each (and mkdir each).
		if err := writeRenderedHTML(outputFile, []byte(html)); err != nil {
			return fmt.Errorf("worker %d: failed to write %s: %w", workerID, outputFile, err)
		}

		log.Printf("[w%d %d/%d] %s -> %s (%d bytes, %v)", workerID, i-start+1, end-start, targetURL, outputFile, len(html), time.Since(stepStart))
	}

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

	tasks = append(tasks, prerenderMetaAction(targetURL))

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
	fs.Var(&cfg.OutputFiles, "output_file", "output file to write (repeatable, must match --url count; may be a comma-separated list of paths to fan out a single render to multiple files)")
	fs.IntVar(&timeoutSec, "timeout", 30, "timeout in seconds (default: 30)")
	fs.IntVar(&cfg.Concurrency, "concurrency", 4, "number of concurrent workers for batch mode")
	fs.BoolVar(&cfg.UseChromedp, "chromedp", true, "use chromedp to render JavaScript (requires Chrome/Chromium)")
	fs.StringVar(&cfg.ChromePath, "chrome_path", "", "path to Chrome/Chromium binary (default: search $PATH)")
	fs.BoolVar(&cfg.SingleContext, "single_context", false, "use one chromedp tab per worker; navigate via history.pushState (SPA only)")
	var settleMs int
	fs.IntVar(&settleMs, "settle_ms", 300, "milliseconds to wait after each navigation/route change before capturing HTML")
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
	cfg.SettleDelay = time.Duration(settleMs) * time.Millisecond
	return
}
