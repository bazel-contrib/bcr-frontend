package main

import (
	"encoding/xml"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

// URLSet represents the root element of a sitemap
type URLSet struct {
	XMLName xml.Name `xml:"urlset"`
	Xmlns   string   `xml:"xmlns,attr"`
	URLs    []URL    `xml:"url"`
}

// URL represents a single URL entry in the sitemap
type URL struct {
	Loc        string  `xml:"loc"`
	LastMod    string  `xml:"lastmod,omitempty"`
	ChangeFreq string  `xml:"changefreq,omitempty"`
	Priority   float64 `xml:"priority,omitempty"`
}

type Config struct {
	RegistryFile string
	OutputFile   string
	BaseURL      string
}

func main() {
	log.SetPrefix("sitemapcompiler: ")
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

	if cfg.RegistryFile == "" {
		return fmt.Errorf("--registry_file is required")
	}
	if cfg.OutputFile == "" {
		return fmt.Errorf("--output_file is required")
	}
	if cfg.BaseURL == "" {
		return fmt.Errorf("--base_url is required")
	}

	registry := &bzpb.Registry{}
	if err := protoutil.ReadFile(cfg.RegistryFile, registry); err != nil {
		return fmt.Errorf("failed to read registry file: %w", err)
	}

	sitemap, err := generateSitemap(registry, cfg.BaseURL)
	if err != nil {
		return fmt.Errorf("failed to generate sitemap: %w", err)
	}

	if err := writeSitemap(cfg.OutputFile, sitemap); err != nil {
		return fmt.Errorf("failed to write sitemap: %w", err)
	}

	log.Printf("Generated sitemap with %d URLs", len(sitemap.URLs))
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet("sitemapcompiler", flag.ExitOnError)
	fs.StringVar(&cfg.RegistryFile, "registry_file", "", "path to the registry protobuf file")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "path to the output sitemap.xml file")
	fs.StringVar(&cfg.BaseURL, "base_url", "", "base URL for the sitemap (e.g., https://example.com)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: sitemapcompiler [options]\n")
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}
	return
}

func generateSitemap(registry *bzpb.Registry, baseURL string) (*URLSet, error) {
	sitemap := &URLSet{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		URLs:  make([]URL, 0),
	}

	// Add homepage
	sitemap.URLs = append(sitemap.URLs, URL{
		Loc:        baseURL,
		ChangeFreq: "daily",
		Priority:   1.0,
	})

	// Add modules index page
	sitemap.URLs = append(sitemap.URLs, URL{
		Loc:        fmt.Sprintf("%s/modules", baseURL),
		ChangeFreq: "daily",
		Priority:   0.9,
	})

	// Iterate through all modules
	for _, module := range registry.Modules {
		if module.Name == "" {
			continue
		}

		// Add module page
		moduleURL := URL{
			Loc:        fmt.Sprintf("%s/modules/%s", baseURL, module.Name),
			ChangeFreq: "weekly",
			Priority:   0.8,
		}
		sitemap.URLs = append(sitemap.URLs, moduleURL)

		// Iterate through all module versions
		for _, version := range module.Versions {
			if version.Version == "" {
				continue
			}

			versionURL := URL{
				Loc:        fmt.Sprintf("%s/modules/%s/%s", baseURL, module.Name, version.Version),
				ChangeFreq: "monthly",
				Priority:   0.7,
			}

			// Add lastmod if we have commit date
			if version.Commit != nil && version.Commit.Date != "" {
				// Parse and format the date if it's valid
				if t, err := time.Parse(time.RFC3339, version.Commit.Date); err == nil {
					versionURL.LastMod = t.Format("2006-01-02")
				}
			}

			sitemap.URLs = append(sitemap.URLs, versionURL)
		}
	}

	return sitemap, nil
}

func writeSitemap(filename string, sitemap *URLSet) error {
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer file.Close()

	// Write XML header
	if _, err := file.WriteString(xml.Header); err != nil {
		return fmt.Errorf("write xml header: %w", err)
	}

	// Marshal and write the sitemap
	encoder := xml.NewEncoder(file)
	encoder.Indent("", "  ")
	if err := encoder.Encode(sitemap); err != nil {
		return fmt.Errorf("encode xml: %w", err)
	}

	if _, err := file.WriteString("\n"); err != nil {
		return fmt.Errorf("write newline: %w", err)
	}

	return nil
}
