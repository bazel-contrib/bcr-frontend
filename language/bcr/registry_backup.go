package bcr

import (
	"compress/gzip"
	"io"
	"log"
	"net/http"
	"strings"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"google.golang.org/protobuf/proto"
)

// loadBackupRegistry fetches and loads the backup registry from the configured URL
func (ext *bcrExtension) loadBackupRegistry() {
	if ext.registrySourceURL == "" {
		return
	}

	log.Printf("Fetching backup registry from %s", ext.registrySourceURL)

	resp, err := http.Get(ext.registrySourceURL)
	if err != nil {
		log.Printf("warning: failed to fetch backup registry: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("warning: failed to fetch backup registry: HTTP %d", resp.StatusCode)
		return
	}

	var reader io.Reader = resp.Body

	// If the URL ends with .gz, decompress
	if strings.HasSuffix(ext.registrySourceURL, ".gz") {
		gzReader, err := gzip.NewReader(resp.Body)
		if err != nil {
			log.Printf("warning: failed to decompress backup registry: %v", err)
			return
		}
		defer gzReader.Close()
		reader = gzReader
	}

	// Read the protobuf data
	data, err := io.ReadAll(reader)
	if err != nil {
		log.Printf("warning: failed to read backup registry data: %v", err)
		return
	}

	// Unmarshal the Registry protobuf
	registry := &bzpb.Registry{}
	if err := proto.Unmarshal(data, registry); err != nil {
		log.Printf("warning: failed to unmarshal backup registry: %v", err)
		return
	}

	ext.backupRegistry = registry
	log.Printf("Loaded backup registry with %d modules", len(registry.Modules))
}

// getBackupRepositoryMetadata retrieves repository metadata from the backup registry
func (ext *bcrExtension) getBackupRepositoryMetadata(repoID repositoryID) *bzpb.RepositoryMetadata {
	if ext.backupRegistry == nil {
		return nil
	}

	// Search through all modules to find matching repository metadata
	for _, module := range ext.backupRegistry.Modules {
		if module.RepositoryMetadata == nil {
			continue
		}

		// Check if this repository matches what we're looking for
		backupRepoID := formatRepositoryID(module.RepositoryMetadata)
		if backupRepoID == repoID {
			return module.RepositoryMetadata
		}
	}

	return nil
}

// getBackupRepositoryMetadataForModule retrieves repository metadata from a specific module version
func (ext *bcrExtension) getBackupRepositoryMetadataForModule(moduleName, version string) *bzpb.RepositoryMetadata {
	if ext.backupRegistry == nil {
		return nil
	}

	// Find the module
	for _, module := range ext.backupRegistry.Modules {
		if module.Name != moduleName {
			continue
		}

		// Find the version
		for _, v := range module.Versions {
			if v.Version == version && v.RepositoryMetadata != nil {
				return v.RepositoryMetadata
			}
		}

		// Also check module-level metadata
		if module.RepositoryMetadata != nil {
			return module.RepositoryMetadata
		}
	}

	return nil
}

// getBackupModuleSource retrieves module source (including commit SHA) from the backup registry
func (ext *bcrExtension) getBackupModuleSource(moduleName, version string) *bzpb.ModuleSource {
	if ext.backupRegistry == nil {
		return nil
	}

	// Find the module in backup registry
	for _, module := range ext.backupRegistry.Modules {
		if module.Name != moduleName {
			continue
		}

		// Find the version
		for _, v := range module.Versions {
			if v.Version == version && v.Source != nil {
				return v.Source
			}
		}
	}

	return nil
}

// populateFromBackupRegistry attempts to populate repository metadata from the backup registry
// Returns the number of repositories successfully populated
func (ext *bcrExtension) populateFromBackupRegistry(repositories []*bzpb.RepositoryMetadata) int {
	if ext.backupRegistry == nil {
		return 0
	}

	populated := 0

	for _, md := range repositories {
		if md == nil {
			continue
		}

		// Try to find matching metadata in backup registry
		backupMd := ext.getBackupRepositoryMetadata(formatRepositoryID(md))
		if backupMd == nil {
			continue
		}

		// Copy over the metadata fields we care about
		if backupMd.Description != "" {
			md.Description = backupMd.Description
		}
		if backupMd.Stargazers > 0 {
			md.Stargazers = backupMd.Stargazers
		}
		if len(backupMd.Languages) > 0 {
			if md.Languages == nil {
				md.Languages = make(map[string]int32)
			}
			for lang, bytes := range backupMd.Languages {
				md.Languages[lang] = bytes
			}
		}
		if backupMd.PrimaryLanguage != "" {
			md.PrimaryLanguage = backupMd.PrimaryLanguage
		}
		if backupMd.CanonicalName != "" {
			md.CanonicalName = backupMd.CanonicalName
		}

		populated++
	}

	return populated
}
