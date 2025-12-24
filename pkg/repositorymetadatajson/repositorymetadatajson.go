package repositorymetadatajson

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

// jsonRepositoryMetadata is the intermediate JSON structure
type jsonRepositoryMetadata struct {
	Type            string            `json:"type"`
	Organization    string            `json:"organization"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Stargazers      int32             `json:"stargazers"`
	Languages       map[string]string `json:"languages"`
	CanonicalName   string            `json:"canonical_name"`
	PrimaryLanguage string            `json:"primary_language"`
}

// ReadFile reads and parses a repository metadata JSON file into a RepositoryMetadata protobuf
func ReadFile(filename string) (*bzpb.RepositoryMetadata, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("reading file: %v", err)
	}

	var jsonMeta jsonRepositoryMetadata
	if err := json.Unmarshal(data, &jsonMeta); err != nil {
		return nil, fmt.Errorf("parsing JSON: %v", err)
	}

	// Convert to proto
	md := &bzpb.RepositoryMetadata{
		CanonicalName:   jsonMeta.CanonicalName,
		Organization:    jsonMeta.Organization,
		Name:            jsonMeta.Name,
		Description:     jsonMeta.Description,
		PrimaryLanguage: jsonMeta.PrimaryLanguage,
		Stargazers:      jsonMeta.Stargazers,
	}

	// Parse type string to enum
	switch jsonMeta.Type {
	case "GITHUB", "github":
		md.Type = bzpb.RepositoryType_GITHUB
	case "GITLAB", "gitlab":
		md.Type = bzpb.RepositoryType_GITLAB
	case "REPOSITORY_TYPE_UNKNOWN", "":
		md.Type = bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN
	default:
		return nil, fmt.Errorf("unknown repository type: %s", jsonMeta.Type)
	}

	// Convert languages from map[string]string to map[string]int32
	if len(jsonMeta.Languages) > 0 {
		md.Languages = make(map[string]int32, len(jsonMeta.Languages))
		for lang, sizeStr := range jsonMeta.Languages {
			size, err := strconv.ParseInt(sizeStr, 10, 32)
			if err != nil {
				return nil, fmt.Errorf("invalid language size for %s: %v", lang, err)
			}
			md.Languages[lang] = int32(size)
		}
	}

	return md, nil
}
