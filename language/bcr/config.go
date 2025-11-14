package bcr

import (
	"log"

	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const (
	bcrLangName = "bcr"
)

const (
	// root of the modules tree.
	bcrModulesRootDirective = "bcr_modules_root"
)

// Config represents the config extension for the a bcr package.
type Config struct {
	config      *config.Config
	rel         string
	modulesRoot string
	enabled     bool
}

// createConfig initializes a new Config.
func createConfig(config *config.Config, rel string) *Config {
	return &Config{
		config: config,
		rel:    rel,
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
func getOrCreateConfig(config *config.Config, rel string) *Config {
	var cfg *Config
	if existingExt, ok := config.Exts[bcrLangName]; ok {
		cfg = existingExt.(*Config).clone(config, rel)
	} else {
		cfg = createConfig(config, rel)
	}
	config.Exts[bcrLangName] = cfg
	return cfg
}

// clone copies this config to a new one.
func (c *Config) clone(config *config.Config, rel string) *Config {
	clone := createConfig(config, rel)
	clone.modulesRoot = c.modulesRoot
	clone.enabled = c.enabled
	return clone
}

// Config returns the parent gazelle configuration
func (c *Config) Config() *config.Config {
	return c.config
}

// Rel returns the parent gazelle relative path
func (c *Config) Rel() string {
	return c.rel
}

// parseDirectives is called in each directory visited by gazelle.  The relative
// directory name is given by 'rel' and the list of directives in the BUILD file
// are specified by 'directives'.
func (c *Config) parseDirectives(rel string, directives []rule.Directive) error {
	for _, d := range directives {
		switch d.Key {
		case bcrModulesRootDirective:
			if err := c.parseBcrModulesRootDirective(rel, d); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *Config) parseBcrModulesRootDirective(rel string, d rule.Directive) error {
	c.modulesRoot = rel
	c.enabled = true
	return nil
}
