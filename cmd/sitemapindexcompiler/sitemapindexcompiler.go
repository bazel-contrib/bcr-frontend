// sitemapindexcompiler reads a JSON manifest of routes (one per SPA-visible
// URL) and writes:
//
//   - sitemap.xml.gz — gzipped urlset XML
//   - sitemapindex.xml — sitemap-index pointing at the single sitemap above
//
// The manifest is produced by the module_registry Starlark rule via
// ctx.actions.write — see rules/module_registry.bzl _compile_sitemap_index_action.
// Each entry is { loc, lastmod, priority, changefreq } where loc may be either
// a fully-qualified URL or a path beginning with '/' (resolved against
// --base_url at write time).
package main

import (
	"compress/gzip"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

// routeEntry mirrors the dict shape written by _route_to_dict in module_registry.bzl.
type routeEntry struct {
	Loc        string  `json:"loc"`
	LastMod    string  `json:"lastmod"`
	Priority   float64 `json:"priority"`
	ChangeFreq string  `json:"changefreq"`
}

// URLSet is the root of a sitemap.xml.
type URLSet struct {
	XMLName xml.Name `xml:"urlset"`
	Xmlns   string   `xml:"xmlns,attr"`
	URLs    []url    `xml:"url"`
}

type url struct {
	Loc        string  `xml:"loc"`
	LastMod    string  `xml:"lastmod,omitempty"`
	ChangeFreq string  `xml:"changefreq,omitempty"`
	Priority   float64 `xml:"priority,omitempty"`
}

// SitemapIndex is the root of a sitemapindex.xml.
type SitemapIndex struct {
	XMLName  xml.Name      `xml:"sitemapindex"`
	Xmlns    string        `xml:"xmlns,attr"`
	Sitemaps []sitemapRef  `xml:"sitemap"`
}

type sitemapRef struct {
	Loc string `xml:"loc"`
}

type config struct {
	RoutesFile         string
	BaseURL            string
	SitemapOutput      string
	SitemapIndexOutput string
	SitemapURL         string
}

func main() {
	log.SetPrefix("sitemapindexcompiler: ")
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
	if cfg.RoutesFile == "" {
		return fmt.Errorf("--routes_file is required")
	}
	if cfg.BaseURL == "" {
		return fmt.Errorf("--base_url is required")
	}
	if cfg.SitemapOutput == "" {
		return fmt.Errorf("--sitemap_output is required")
	}
	if cfg.SitemapIndexOutput == "" {
		return fmt.Errorf("--sitemapindex_output is required")
	}
	if cfg.SitemapURL == "" {
		return fmt.Errorf("--sitemap_url is required")
	}

	routes, err := readRoutes(cfg.RoutesFile)
	if err != nil {
		return fmt.Errorf("reading routes: %w", err)
	}

	urls := make([]url, 0, len(routes))
	for _, r := range routes {
		loc := r.Loc
		if strings.HasPrefix(loc, "/") {
			loc = strings.TrimRight(cfg.BaseURL, "/") + loc
		}
		urls = append(urls, url{
			Loc:        loc,
			LastMod:    r.LastMod,
			ChangeFreq: r.ChangeFreq,
			Priority:   r.Priority,
		})
	}

	if err := writeGzippedSitemap(cfg.SitemapOutput, urls); err != nil {
		return fmt.Errorf("writing sitemap: %w", err)
	}
	if err := writeSitemapIndex(cfg.SitemapIndexOutput, cfg.SitemapURL); err != nil {
		return fmt.Errorf("writing sitemap index: %w", err)
	}

	log.Printf("Wrote sitemap (%d URLs) to %s; index to %s",
		len(urls), cfg.SitemapOutput, cfg.SitemapIndexOutput)
	return nil
}

func parseFlags(args []string) (config, error) {
	var cfg config
	fs := flag.NewFlagSet("sitemapindexcompiler", flag.ExitOnError)
	fs.StringVar(&cfg.RoutesFile, "routes_file", "", "JSON file of routes (list of {loc, lastmod, priority, changefreq})")
	fs.StringVar(&cfg.BaseURL, "base_url", "", "base URL prepended to routes whose loc begins with '/' (e.g., https://registry.bazel.build)")
	fs.StringVar(&cfg.SitemapOutput, "sitemap_output", "", "output path for the gzipped sitemap.xml.gz")
	fs.StringVar(&cfg.SitemapIndexOutput, "sitemapindex_output", "", "output path for sitemapindex.xml")
	fs.StringVar(&cfg.SitemapURL, "sitemap_url", "", "public URL the sitemap is served from (used in sitemapindex.xml)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: sitemapindexcompiler [options]\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func readRoutes(path string) ([]routeEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var routes []routeEntry
	if err := json.Unmarshal(data, &routes); err != nil {
		return nil, fmt.Errorf("unmarshal routes JSON: %w", err)
	}
	return routes, nil
}

func writeGzippedSitemap(path string, urls []url) error {
	urlset := &URLSet{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		URLs:  urls,
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	defer gz.Close()

	if _, err := gz.Write([]byte(xml.Header)); err != nil {
		return err
	}
	enc := xml.NewEncoder(gz)
	enc.Indent("", "  ")
	if err := enc.Encode(urlset); err != nil {
		return fmt.Errorf("encode urlset: %w", err)
	}
	if _, err := gz.Write([]byte("\n")); err != nil {
		return err
	}
	return nil
}

func writeSitemapIndex(path, sitemapURL string) error {
	idx := &SitemapIndex{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		Sitemaps: []sitemapRef{
			{Loc: sitemapURL},
		},
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(xml.Header); err != nil {
		return err
	}
	enc := xml.NewEncoder(f)
	enc.Indent("", "  ")
	if err := enc.Encode(idx); err != nil {
		return fmt.Errorf("encode sitemapindex: %w", err)
	}
	if _, err := f.WriteString("\n"); err != nil {
		return err
	}
	return nil
}
