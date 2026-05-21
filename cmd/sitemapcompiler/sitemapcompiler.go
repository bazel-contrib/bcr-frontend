package main

import (
	"encoding/xml"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	bhpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/help/v1"
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

// versionLastMod returns the version's commit date as YYYY-MM-DD, or "" if
// the date is missing or unparseable. Used as the <lastmod> for every
// per-version URL emitted into the sitemap.
func versionLastMod(version *bzpb.ModuleVersion) string {
	if version == nil || version.Commit == nil || version.Commit.Date == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, version.Commit.Date)
	if err != nil {
		return ""
	}
	return t.Format("2006-01-02")
}

// safeURLPath %-escapes each `/`-separated segment of a path component while
// preserving slashes as path separators. Used for overlay/patch/package
// drill-down URLs where the underlying string may contain characters Bazel
// permits but URLs reserve (most filenames are clean; treat this as defense
// in depth).
func safeURLPath(p string) string {
	parts := strings.Split(p, "/")
	for i, seg := range parts {
		parts[i] = url.PathEscape(seg)
	}
	return strings.Join(parts, "/")
}

// stripRepoPrefix mirrors the JS-side helper in app/bcr/packages.soy: strips
// a leading "@@<repo>//" or "@<repo>//" off a Bazel package label so the
// remainder is suitable for use in a URL path. Empty result (root package)
// is returned as "" — the caller decides whether to emit a URL for it.
func stripRepoPrefix(name string) string {
	idx := strings.Index(name, "//")
	if idx < 0 {
		return name
	}
	return name[idx+2:]
}

// loadLabelURLKey mirrors loadLabelToUrlKey in app/bcr/starlark.js: encodes a
// load-symbol coordinate into the URL form used by the /targets view's Trie
// router. Empty `pkg` collapses out so `@swig//:swig.bzl%swig_library`
// becomes `@swig/swig.bzl/swig_library`.
func loadLabelURLKey(repo, pkg, file, symbol string) string {
	if pkg != "" {
		return fmt.Sprintf("@%s/%s/%s/%s", repo, pkg, file, symbol)
	}
	return fmt.Sprintf("@%s/%s/%s", repo, file, symbol)
}

type Config struct {
	RegistryFile    string
	BazelFlagDbFile string
	OutputFile      string
	BaseURL         string
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

	// The flag DB is optional — dummy/test builds compile a sitemap with
	// no flag entries.
	var flagDb *bhpb.BazelFlagDb
	if cfg.BazelFlagDbFile != "" {
		flagDb = &bhpb.BazelFlagDb{}
		if err := protoutil.ReadFile(cfg.BazelFlagDbFile, flagDb); err != nil {
			return fmt.Errorf("failed to read bazel flag db file: %w", err)
		}
	}

	sitemap, err := generateSitemap(registry, flagDb, cfg.BaseURL)
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
	fs.StringVar(&cfg.BazelFlagDbFile, "bazel_flag_db_file", "", "optional path to the bazel flag database protobuf (enables /bazel/flags URLs)")
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

func generateSitemap(registry *bzpb.Registry, flagDb *bhpb.BazelFlagDb, baseURL string) (*URLSet, error) {
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

	// Add Bazel core index pages + the SPA's sub-tab landing routes under
	// /bazel/versions and /bazel/flags/list (BazelOverviewSelectNav,
	// BazelFlagsListSelectNav in app/bcr/bazel*.js).
	for _, p := range []string{
		"/bazel",
		"/bazel/versions",
		"/bazel/versions/versions",
		"/bazel/flags",
		"/bazel/flags/list",
		"/bazel/flags/list/categories",
		"/bazel/flags/list/tags",
	} {
		sitemap.URLs = append(sitemap.URLs, URL{
			Loc:        baseURL + p,
			ChangeFreq: "weekly",
			Priority:   0.9,
		})
	}

	// Add registry-wide Targets landing page.
	sitemap.URLs = append(sitemap.URLs, URL{
		Loc:        baseURL + "/targets",
		ChangeFreq: "weekly",
		Priority:   0.7,
	})

	// Add per-version Bazel pages from the bazel_tools pseudo-module.
	for _, module := range registry.Modules {
		if module.Name != "bazel_tools" {
			continue
		}
		for _, version := range module.Versions {
			if version.Version == "" {
				continue
			}
			sitemap.URLs = append(sitemap.URLs, URL{
				Loc:        fmt.Sprintf("%s/bazel/%s", baseURL, version.Version),
				ChangeFreq: "monthly",
				Priority:   0.7,
				LastMod:    versionLastMod(version),
			})
		}
		break
	}

	// Add per-flag, per-tag, per-category, and per-command pages from the
	// flag DB.
	if flagDb != nil {
		seenTags := make(map[string]struct{})
		seenCats := make(map[string]struct{})
		for _, f := range flagDb.Flag {
			if f.Name == "" {
				continue
			}
			sitemap.URLs = append(sitemap.URLs, URL{
				Loc:        fmt.Sprintf("%s/bazel/flags/%s", baseURL, f.Name),
				ChangeFreq: "monthly",
				Priority:   0.6,
			})
			for _, tag := range f.Tag {
				if tag == "" {
					continue
				}
				if _, ok := seenTags[tag]; ok {
					continue
				}
				seenTags[tag] = struct{}{}
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/bazel/flags/tag/%s", baseURL, tag),
					ChangeFreq: "monthly",
					Priority:   0.5,
				})
			}
			if f.Category != "" {
				if _, ok := seenCats[f.Category]; !ok {
					seenCats[f.Category] = struct{}{}
					sitemap.URLs = append(sitemap.URLs, URL{
						Loc:        fmt.Sprintf("%s/bazel/flags/category/%s", baseURL, url.PathEscape(f.Category)),
						ChangeFreq: "monthly",
						Priority:   0.5,
					})
				}
			}
		}
		for _, cmd := range flagDb.Commands {
			if cmd == "" {
				continue
			}
			sitemap.URLs = append(sitemap.URLs, URL{
				Loc:        fmt.Sprintf("%s/bazel/command/%s", baseURL, cmd),
				ChangeFreq: "monthly",
				Priority:   0.5,
			})
		}
	}

	// Collect unique /targets/<urlKey> values across the whole registry while
	// iterating the per-module loop below; emit the deduped set at the end.
	targetURLKeys := make(map[string]struct{})

	// Iterate through all modules
	for _, module := range registry.Modules {
		if module.Name == "" {
			continue
		}

		// Add module page
		sitemap.URLs = append(sitemap.URLs, URL{
			Loc:        fmt.Sprintf("%s/modules/%s", baseURL, module.Name),
			ChangeFreq: "weekly",
			Priority:   0.8,
		})

		// Iterate through all module versions
		for _, version := range module.Versions {
			if version.Version == "" {
				continue
			}

			lastMod := versionLastMod(version)
			versionBase := fmt.Sprintf("%s/modules/%s/%s", baseURL, module.Name, version.Version)

			// Bare module-version URL — Overview is the default tab there,
			// so no separate /overview emission is needed.
			sitemap.URLs = append(sitemap.URLs, URL{
				Loc:        versionBase,
				ChangeFreq: "monthly",
				Priority:   0.7,
				LastMod:    lastMod,
			})

			// Documentation file + symbol URLs (no separate /docs landing —
			// these per-file URLs cover the SPA's drill-down surface).
			if version.Source != nil && version.Source.Documentation != nil {
				for _, file := range version.Source.Documentation.File {
					if file.Label == nil {
						continue
					}
					filePath := path.Join(file.Label.Pkg, file.Label.Name)
					fileLoc := fmt.Sprintf("%s/docs/%s", versionBase, filePath)
					sitemap.URLs = append(sitemap.URLs, URL{
						Loc:        fileLoc,
						ChangeFreq: "monthly",
						Priority:   0.6,
						LastMod:    lastMod,
					})
					for _, sym := range file.Symbol {
						sitemap.URLs = append(sitemap.URLs, URL{
							Loc:        fmt.Sprintf("%s/%s", fileLoc, sym.Name),
							ChangeFreq: "monthly",
							Priority:   0.5,
							LastMod:    lastMod,
						})
					}
				}
			}

			// Packages tab + per-package drill-down. Also harvests the
			// per-rule-kind load coordinates that feed /targets/<urlKey>.
			if version.Source != nil && version.Source.Packages != nil &&
				len(version.Source.Packages.Package) > 0 {
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/packages", versionBase),
					ChangeFreq: "monthly",
					Priority:   0.6,
					LastMod:    lastMod,
				})
				for _, pkg := range version.Source.Packages.Package {
					pkgPath := stripRepoPrefix(pkg.Name)
					if pkgPath != "" {
						sitemap.URLs = append(sitemap.URLs, URL{
							Loc:        fmt.Sprintf("%s/packages/%s", versionBase, safeURLPath(pkgPath)),
							ChangeFreq: "monthly",
							Priority:   0.5,
							LastMod:    lastMod,
						})
					}
					// Harvest urlKeys: for each target's rule kind, find the
					// load statement whose alias (To, falling back to From)
					// matches that kind, and encode the load coordinate.
					for _, target := range pkg.Target {
						if target.Rule == "" {
							continue
						}
						for _, ls := range pkg.Load {
							if ls.Label == nil {
								continue
							}
							for _, sym := range ls.Symbol {
								local := sym.To
								if local == "" {
									local = sym.From
								}
								if local != target.Rule {
									continue
								}
								key := loadLabelURLKey(ls.Label.Repo, ls.Label.Pkg, ls.Label.Name, sym.From)
								if key != "" {
									targetURLKeys[key] = struct{}{}
								}
							}
						}
					}
				}
			}

			// Attestations tab — only when attestations.json had entries.
			if version.Attestations != nil && len(version.Attestations.Attestations) > 0 {
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/attestations", versionBase),
					ChangeFreq: "monthly",
					Priority:   0.6,
					LastMod:    lastMod,
				})
			}

			// Overlay tab + per-file drill-down (the Trie-routed file viewer).
			if version.Source != nil && len(version.Source.Overlay) > 0 {
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/overlay", versionBase),
					ChangeFreq: "monthly",
					Priority:   0.6,
					LastMod:    lastMod,
				})
				for filename := range version.Source.Overlay {
					sitemap.URLs = append(sitemap.URLs, URL{
						Loc:        fmt.Sprintf("%s/overlay/%s", versionBase, safeURLPath(filename)),
						ChangeFreq: "monthly",
						Priority:   0.5,
						LastMod:    lastMod,
					})
				}
			}

			// Patches tab + per-file drill-down.
			if version.Source != nil && len(version.Source.Patches) > 0 {
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/patches", versionBase),
					ChangeFreq: "monthly",
					Priority:   0.6,
					LastMod:    lastMod,
				})
				for filename := range version.Source.Patches {
					sitemap.URLs = append(sitemap.URLs, URL{
						Loc:        fmt.Sprintf("%s/patches/%s", versionBase, safeURLPath(filename)),
						ChangeFreq: "monthly",
						Priority:   0.5,
						LastMod:    lastMod,
					})
				}
			}

			// Testing tab — only when a presubmit configuration is attached.
			if version.Presubmit != nil {
				sitemap.URLs = append(sitemap.URLs, URL{
					Loc:        fmt.Sprintf("%s/testing", versionBase),
					ChangeFreq: "monthly",
					Priority:   0.6,
					LastMod:    lastMod,
				})
			}
		}
	}

	// Emit /targets/<urlKey> for every unique rule-kind load coordinate
	// harvested above. Sorted so the sitemap diff is stable across runs.
	if len(targetURLKeys) > 0 {
		keys := make([]string, 0, len(targetURLKeys))
		for k := range targetURLKeys {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			sitemap.URLs = append(sitemap.URLs, URL{
				Loc:        fmt.Sprintf("%s/targets/%s", baseURL, safeURLPath(k)),
				ChangeFreq: "weekly",
				Priority:   0.5,
			})
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
