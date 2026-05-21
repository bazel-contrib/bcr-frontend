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

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
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
	// Tab-pool / leak-control options.
	ChromedpPool int
	TabMaxPages  int
	ReadySignal  bool
	// Resource blocking via CDP Network.SetBlockedURLs. Comma-separated
	// keyword list: images, fonts, media, all. Empty disables blocking.
	BlockResources string
	// Performance options
	DisableImages bool
	DisableCSS    bool
	DisableJS     bool
	// Mirror log output to this file as it's written. Bazel buffers an
	// action's stderr until completion; this lets a user tail -f a known
	// path to watch shard progress in real time.
	ProgressLog string
	// Per-URL render line is noisy for batches of 1000+. Default off:
	// stderr stays quiet (Bazel flushes it all at action-end), and the
	// per-URL line is written to ProgressLog if set. Flip to true to
	// also emit it to stderr.
	Verbose bool
	// On a per-render failure (chromedp error, timeout, or otherwise),
	// retry up to this many times with a fresh tab. The default of 1
	// covers transient errors (tab/renderer crash, occasional CDP race)
	// without masking systemic bugs.
	Retries int
	// Pre-warm every pool tab against the SPA's root URL with this max
	// concurrency before processing any real URLs. Serializes the cold-start
	// REGISTRY_DATA parse so a 16-way simultaneous parse doesn't push tabs
	// past --timeout. 0 disables warmup.
	WarmupConcurrency int
	// Open file handle for ProgressLog (populated by run() — not a flag).
	// Per-URL render lines go to this file unconditionally so tail -f
	// remains useful even when --verbose is off.
	progressFile *os.File
}

// logURL emits a per-URL progress line. By default (Verbose=false) it only
// reaches the progress-log file (when set) so stderr — which Bazel buffers
// and dumps at action-end — stays free of thousands of lines. With
// Verbose=true the line also goes to stderr via the standard log.
func logURL(cfg Config, format string, args ...any) {
	if cfg.Verbose {
		log.Printf(format, args...)
		return
	}
	if cfg.progressFile != nil {
		fmt.Fprintf(cfg.progressFile, "statichtmlcompiler: "+format+"\n", args...)
	}
}

// blockedURLPatternsForCfg expands the comma-separated --block_resources
// keywords into wildcard URL patterns suitable for CDP
// Network.setBlockedURLs. `--disable_images=true` also implies blocking
// image patterns (back-compat for the previously-dead flag).
func blockedURLPatternsForCfg(cfg Config) []string {
	kinds := map[string]bool{}
	if cfg.DisableImages {
		kinds["images"] = true
	}
	for _, k := range strings.Split(cfg.BlockResources, ",") {
		k = strings.TrimSpace(strings.ToLower(k))
		if k == "" || k == "none" {
			continue
		}
		if k == "all" {
			kinds["images"] = true
			kinds["fonts"] = true
			kinds["media"] = true
			continue
		}
		kinds[k] = true
	}
	var patterns []string
	if kinds["images"] {
		patterns = append(patterns,
			"*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg",
			"*.webp", "*.ico", "*.avif",
		)
	}
	if kinds["fonts"] {
		patterns = append(patterns,
			"*.woff", "*.woff2", "*.ttf", "*.otf", "*.eot",
		)
	}
	if kinds["media"] {
		patterns = append(patterns,
			"*.mp4", "*.webm", "*.m4a", "*.mp3", "*.ogg",
		)
	}
	return patterns
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

	// If a progress-log path was provided, fan summary log output to that
	// file in addition to stderr. Per-URL render lines (which can be 1000+
	// for a full BCR build) go to the file unconditionally via logURL;
	// they reach stderr only when --verbose is on.
	if cfg.ProgressLog != "" {
		f, err := os.OpenFile(cfg.ProgressLog, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
		if err != nil {
			return fmt.Errorf("open progress_log %q: %w", cfg.ProgressLog, err)
		}
		defer f.Close()
		cfg.progressFile = f
		log.SetOutput(io.MultiWriter(os.Stderr, f))
		log.Printf("Progress log: %s", cfg.ProgressLog)
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

	// Batch mode with a chromedp tab pool inside one Chrome process. Each
	// tab is reused for multiple URLs via SPA-style pushState; tabs are
	// recycled after --tab_max_pages renders to keep memory bounded.
	// Triggered by --chromedp_pool>1 OR the legacy --single_context flag.
	if cfg.UseChromedp && (cfg.ChromedpPool > 1 || cfg.SingleContext) {
		return processBatchPool(cfg)
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

// tab is a single chromedp browser tab — the unit of work the pool hands out.
// pageCount tracks pages rendered since the tab was created; the pool
// recycles a tab once it crosses cfg.TabMaxPages to keep JS heap from
// drifting upward across thousands of SPA navigations.
type tab struct {
	ctx          context.Context
	cancel       context.CancelFunc
	pageCount    int
	hasNavigated bool
}

// pool holds N reusable chromedp tabs under a single Chrome process
// (allocCtx). Workers acquire/release tabs through a buffered channel;
// `sem` limits the total in-flight tab count to ChromedpPool so we don't
// outgrow the cap during the lazy ramp-up.
type pool struct {
	cfg              Config
	allocCtx         context.Context
	blockedPatterns  []string
	idle             chan *tab
	sem              chan struct{}
	workerID         atomicCounter
}

type atomicCounter struct {
	mu sync.Mutex
	n  int
}

func (c *atomicCounter) next() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	return c.n - 1
}

func newPool(cfg Config) (*pool, context.CancelFunc) {
	opts := buildChromedpOpts(cfg)
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	return &pool{
		cfg:             cfg,
		allocCtx:        allocCtx,
		blockedPatterns: blockedURLPatternsForCfg(cfg),
		idle:            make(chan *tab, cfg.ChromedpPool),
		sem:             make(chan struct{}, cfg.ChromedpPool),
	}, allocCancel
}

func (p *pool) newTab() (*tab, error) {
	tabCtx, tabCancel := chromedp.NewContext(p.allocCtx)

	// Per-tab setup: enable Network domain so SetBlockedURLs takes effect,
	// install the resource block list, and pre-arm the prerender-ready
	// reset script for every freshly-loaded document.
	setup := chromedp.Tasks{
		network.Enable(),
	}
	if len(p.blockedPatterns) > 0 {
		setup = append(setup, network.SetBlockedURLs(p.blockedPatterns))
	}
	setup = append(setup, chromedp.ActionFunc(func(ctx context.Context) error {
		_, err := page.AddScriptToEvaluateOnNewDocument(
			`window.__bcrPrerenderReady = false;`,
		).Do(ctx)
		return err
	}))

	if err := chromedp.Run(tabCtx, setup); err != nil {
		tabCancel()
		return nil, fmt.Errorf("tab setup: %w", err)
	}
	return &tab{ctx: tabCtx, cancel: tabCancel}, nil
}

// acquire blocks until either an idle tab is available or a new tab can be
// minted (subject to the pool's capacity sem). The returned tab must be
// passed back through release() or discard() — never just dropped.
func (p *pool) acquire(ctx context.Context) (*tab, error) {
	select {
	case t := <-p.idle:
		return t, nil
	default:
	}
	// Idle queue empty — try to mint a new tab under the capacity sem.
	select {
	case p.sem <- struct{}{}:
		t, err := p.newTab()
		if err != nil {
			<-p.sem
			return nil, err
		}
		return t, nil
	case t := <-p.idle:
		return t, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// release returns a healthy tab to the idle pool — or, if its pageCount has
// crossed TabMaxPages, disposes it and frees the capacity slot so the next
// acquire() will mint a fresh tab. This is the leak-control mechanism that
// keeps the warm-tab approach safe for long batch runs.
func (p *pool) release(t *tab) {
	if t.pageCount >= p.cfg.TabMaxPages {
		t.cancel()
		<-p.sem
		return
	}
	select {
	case p.idle <- t:
	default:
		// Pool over-full (shouldn't happen with the sem in place) — drop.
		t.cancel()
		<-p.sem
	}
}

// discard disposes a tab outright — used when a render fails and the tab
// may be in an inconsistent state. Freeing the sem slot lets a replacement
// be minted on the next acquire().
func (p *pool) discard(t *tab) {
	t.cancel()
	<-p.sem
}

// warmup mints all p.cfg.ChromedpPool tabs and navigates each to warmURL
// with at most `concurrency` parses in flight. Warm tabs go straight into
// p.idle ready for SPA-style pushState navigation on real URLs.
//
// The point isn't to skip REGISTRY_DATA — every tab still parses it — but
// to deconflict the parse. Under 16-way contention, what should be a ~1.5s
// parse can blow past the per-render --timeout (30s+ tail observed). With
// concurrency=4 here, each tab pays close to the solo cost.
func (p *pool) warmup(warmURL string, concurrency int) error {
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > p.cfg.ChromedpPool {
		concurrency = p.cfg.ChromedpPool
	}
	log.Printf("Warmup: minting %d tabs against %s (concurrency=%d)", p.cfg.ChromedpPool, warmURL, concurrency)
	startedAt := time.Now()

	gate := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	errCh := make(chan error, p.cfg.ChromedpPool)

	for i := 0; i < p.cfg.ChromedpPool; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()

			p.sem <- struct{}{}
			t, err := p.newTab()
			if err != nil {
				<-p.sem
				errCh <- fmt.Errorf("warmup tab %d: %w", i, err)
				return
			}

			var timedOut atomicBool
			timer := time.AfterFunc(p.cfg.Timeout, func() {
				timedOut.set(true)
				t.cancel()
			})
			runErr := chromedp.Run(t.ctx, chromedp.Tasks{
				chromedp.Navigate(warmURL),
				waitForReady(p.cfg),
			})
			timer.Stop()

			if runErr != nil {
				p.discard(t)
				if timedOut.get() {
					errCh <- fmt.Errorf("warmup tab %d: timeout after %v: %w", i, p.cfg.Timeout, runErr)
				} else {
					errCh <- fmt.Errorf("warmup tab %d: %w", i, runErr)
				}
				return
			}
			t.hasNavigated = true
			t.pageCount++
			p.idle <- t
		}(i)
	}
	wg.Wait()
	close(errCh)

	var errs []error
	for err := range errCh {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return fmt.Errorf("warmup: %d errors: %v", len(errs), errs[0])
	}
	log.Printf("Warmup: %d tabs ready in %v", p.cfg.ChromedpPool, time.Since(startedAt))
	return nil
}

// warmupURLFor returns the SPA root URL (scheme://host/) derived from a
// real target URL. Used as the pre-warm destination so each tab parses
// REGISTRY_DATA once on a benign route before serving real requests.
func warmupURLFor(targetURL string) string {
	u, err := url.Parse(targetURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return fmt.Sprintf("%s://%s/", u.Scheme, u.Host)
}

func (p *pool) drain() {
	for {
		select {
		case t := <-p.idle:
			t.cancel()
		default:
			return
		}
	}
}

// processBatchPool renders every URL via a fixed-size pool of reusable
// chromedp tabs inside a single Chrome process. Each tab is reused via
// SPA-style pushState navigation and recycled after TabMaxPages renders
// to bound memory.
//
// Requires: cfg.UseChromedp = true, len(cfg.URLs) >= 1.
func processBatchPool(cfg Config) error {
	if cfg.ChromedpPool < 1 {
		cfg.ChromedpPool = 1
	}
	if cfg.ChromedpPool > len(cfg.URLs) {
		cfg.ChromedpPool = len(cfg.URLs)
	}
	if cfg.TabMaxPages < 1 {
		cfg.TabMaxPages = 1
	}

	log.Printf("Pool batch: %d URLs, %d tabs, recycle every %d pages, ready_signal=%v, block=%v",
		len(cfg.URLs), cfg.ChromedpPool, cfg.TabMaxPages, cfg.ReadySignal, cfg.BlockResources)

	p, allocCancel := newPool(cfg)
	defer allocCancel()
	defer p.drain()

	if cfg.WarmupConcurrency > 0 {
		warmURL := warmupURLFor(cfg.URLs[0])
		if warmURL != "" {
			if err := p.warmup(warmURL, cfg.WarmupConcurrency); err != nil {
				return fmt.Errorf("pool warmup: %w", err)
			}
		}
	}

	urlCh := make(chan int, len(cfg.URLs))
	for i := range cfg.URLs {
		urlCh <- i
	}
	close(urlCh)

	var wg sync.WaitGroup
	errCh := make(chan error, len(cfg.URLs))
	startedAt := time.Now()
	total := len(cfg.URLs)
	var done atomicCounter

	for w := 0; w < cfg.ChromedpPool; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			workerID := p.workerID.next()
			for idx := range urlCh {
				if err := renderOne(p, cfg, workerID, idx, total, &done); err != nil {
					errCh <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)

	var errs []error
	for err := range errCh {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return fmt.Errorf("encountered %d errors: %v", len(errs), errs[0])
	}

	log.Printf("Pool batch: rendered %d URLs in %v", total, time.Since(startedAt))
	return nil
}

func renderOne(p *pool, cfg Config, workerID, idx, total int, done *atomicCounter) error {
	targetURL := cfg.URLs[idx]
	outputFile := cfg.OutputFiles[idx]

	// One attempt + up to cfg.Retries retry attempts. Retry path acquires
	// a fresh tab — a render failure usually means the previous tab is in
	// a broken state (and discard() ensures it's tossed).
	stepStart := time.Now()
	var html string
	var lastErr error
	attempts := cfg.Retries + 1
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 0; attempt < attempts; attempt++ {
		t, err := p.acquire(context.Background())
		if err != nil {
			return fmt.Errorf("worker %d: acquire tab: %w", workerID, err)
		}

		html = ""
		tasks := buildRenderTasks(t, cfg, targetURL, &html)

		// Per-render timeout via time.AfterFunc → tab.cancel(). We can't
		// wrap chromedp.Run in context.WithTimeout(t.ctx, …) because
		// canceling a child of the chromedp Context propagates back into
		// chromedp's Target loop and poisons subsequent calls. Killing the
		// tab outright is fine: on error we discard it anyway.
		var timedOut atomicBool
		timer := time.AfterFunc(cfg.Timeout, func() {
			timedOut.set(true)
			t.cancel()
		})

		runErr := chromedp.Run(t.ctx, tasks)
		timer.Stop()

		if runErr == nil {
			t.pageCount++
			t.hasNavigated = true
			p.release(t)
			break
		}

		// Tab is in a bad state — discard.
		p.discard(t)
		if timedOut.get() {
			lastErr = fmt.Errorf("render timeout after %v on %s: %w", cfg.Timeout, targetURL, runErr)
		} else {
			lastErr = fmt.Errorf("render %s: %w", targetURL, runErr)
		}
		if attempt < attempts-1 {
			logURL(cfg, "[w%d retry %d/%d] %s: %v", workerID, attempt+1, attempts-1, targetURL, lastErr)
			continue
		}
		return fmt.Errorf("worker %d: %w", workerID, lastErr)
	}

	if err := writeRenderedHTML(outputFile, []byte(html)); err != nil {
		return fmt.Errorf("worker %d: write %s: %w", workerID, outputFile, err)
	}
	n := done.next() + 1
	logURL(cfg, "[w%d %d/%d] %s -> %s (%d bytes, %v)",
		workerID, n, total, targetURL, outputFile, len(html), time.Since(stepStart))
	return nil
}

// atomicBool is a tiny goroutine-safe bool — used by renderOne to flag the
// time.AfterFunc timeout path so the error message can say "timeout" rather
// than just "context canceled".
type atomicBool struct {
	mu sync.Mutex
	b  bool
}

func (a *atomicBool) set(v bool) {
	a.mu.Lock()
	a.b = v
	a.mu.Unlock()
}

func (a *atomicBool) get() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.b
}

func buildRenderTasks(t *tab, cfg Config, targetURL string, html *string) chromedp.Tasks {
	if !t.hasNavigated {
		return chromedp.Tasks{
			chromedp.Navigate(targetURL),
			waitForReady(cfg),
			prerenderMetaAction(targetURL),
			chromedp.OuterHTML("html", html),
		}
	}
	// SPA-style navigation on a warm tab: reset the ready flag, then
	// pushState + dispatch popstate so the router catches the change.
	js := fmt.Sprintf(
		`window.__bcrPrerenderReady = false; window.history.pushState({}, '', %q); window.dispatchEvent(new PopStateEvent('popstate', {state: {}}));`,
		targetURL,
	)
	return chromedp.Tasks{
		chromedp.Evaluate(js, nil),
		waitForReady(cfg),
		prerenderMetaAction(targetURL),
		chromedp.OuterHTML("html", html),
	}
}

// waitForReady polls window.__bcrPrerenderReady when the signal is enabled
// (initial Navigate: the SPA flips this at the end of main()). Falls back
// to a fixed cfg.SettleDelay sleep when the signal is disabled or the
// poll times out — the timeout case is expected for SPA pushState
// navigations, since the SPA's router doesn't currently re-emit the flag.
func waitForReady(cfg Config) chromedp.Action {
	return chromedp.ActionFunc(func(ctx context.Context) error {
		if !cfg.ReadySignal {
			return chromedp.Sleep(cfg.SettleDelay).Do(ctx)
		}
		deadline := time.Now().Add(cfg.SettleDelay)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			var ready bool
			if err := chromedp.Evaluate(`!!window.__bcrPrerenderReady`, &ready).Do(ctx); err != nil {
				return err
			}
			if ready {
				return nil
			}
			if time.Now().After(deadline) {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
		}
	})
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
	fs.BoolVar(&cfg.DisableImages, "disable_images", true, "block image-resource fetches via CDP (equivalent to --block_resources=images)")
	fs.BoolVar(&cfg.DisableCSS, "disable_css", false, "disable CSS loading (not recommended for SPAs)")
	fs.BoolVar(&cfg.DisableJS, "disable_js", false, "disable JavaScript (not recommended for SPAs)")
	fs.IntVar(&cfg.ChromedpPool, "chromedp_pool", 16, "number of reusable chromedp tabs in the pool (one Chrome process serves all tabs)")
	fs.IntVar(&cfg.TabMaxPages, "tab_max_pages", 50, "recycle a tab after it has rendered this many pages (keeps JS heap bounded across long batches)")
	fs.BoolVar(&cfg.ReadySignal, "ready_signal", true, "poll window.__bcrPrerenderReady after navigation; falls back to --settle_ms cap when the SPA hasn't (yet) emitted")
	fs.StringVar(&cfg.BlockResources, "block_resources", "images,fonts,media", "comma-separated CDP request-block categories: images, fonts, media, all, none")
	fs.StringVar(&cfg.ProgressLog, "progress_log", "", "mirror log output to this file path; useful with `tail -f` to watch a long shard mid-action since Bazel buffers stderr. Per-URL render lines are written to this file regardless of --verbose")
	fs.BoolVar(&cfg.Verbose, "verbose", false, "also emit the per-URL render line to stderr (Bazel will dump it all at action-end). Default off keeps the final stderr quiet; the line still reaches --progress_log when set")
	fs.IntVar(&cfg.Retries, "retries", 1, "retry a failed render up to N times with a fresh tab. Covers transient chromedp errors (tab/renderer crash, CDP race, per-render timeout) without masking systemic bugs")
	fs.IntVar(&cfg.WarmupConcurrency, "warmup_concurrency", 4, "pre-warm all pool tabs against the SPA root before processing real URLs, with at most this many in-flight REGISTRY_DATA parses. Avoids the cold-start contention spike that times out the first batch under high pool sizes. 0 disables warmup")
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
