package bcr

import (
	"log"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/config"
)

// Config represents the config extension for the a bcr package.
type Config struct {
	config  *config.Config
	enabled bool
}

// createConfig initializes a new Config.
func createConfig(config *config.Config) *Config {
	return &Config{
		config: config,
	}
}

// mustGetConfig returns the scala config.  should only be used after .Configure().
// never nil.
func mustGetConfig(config *config.Config) *Config {
	if existingExt, ok := config.Exts[bcrLangName]; ok {
		return existingExt.(*Config)
	}
	log.Panicln("bcr config nil.  this is a bug")
	return nil
}

// getOrCreateScalaConfig either inserts a new config into the map under the
// language name or replaces it with a clone.
func getOrCreateConfig(config *config.Config) *Config {
	var cfg *Config
	if existingExt, ok := config.Exts[bcrLangName]; ok {
		cfg = existingExt.(*Config).clone(config)
	} else {
		cfg = createConfig(config)
	}
	config.Exts[bcrLangName] = cfg
	return cfg
}

// clone copies this config to a new one.
func (c *Config) clone(config *config.Config) *Config {
	clone := createConfig(config)
	clone.enabled = c.enabled
	return clone
}

// Config returns the parent gazelle configuration
func (c *Config) Config() *config.Config {
	return c.config
}

// stringBoolMap is a custom flag type for repeatable string flags that populates a map
type stringBoolMap map[string]bool

func (m *stringBoolMap) String() string {
	if *m == nil {
		return ""
	}
	urls := make([]string, 0, len(*m))
	for url := range *m {
		urls = append(urls, url)
	}
	return strings.Join(urls, ",")
}

func (m *stringBoolMap) Set(value string) error {
	if *m == nil {
		*m = make(map[string]bool)
	}
	(*m)[value] = true
	return nil
}
