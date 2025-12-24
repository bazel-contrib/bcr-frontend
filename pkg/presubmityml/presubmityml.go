package presubmityml

import (
	"fmt"
	"os"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"gopkg.in/yaml.v3"
)

// presubmitYml represents the structure of a presubmit.yml file
type presubmitYml struct {
	BcrTestModule *bcrTestModule   `yaml:"bcr_test_module,omitempty"`
	Matrix        *matrix          `yaml:"matrix,omitempty"`
	Tasks         map[string]*task `yaml:"tasks,omitempty"`
}

// bcrTestModule represents the bcr_test_module section
type bcrTestModule struct {
	ModulePath string           `yaml:"module_path"`
	Matrix     *matrix          `yaml:"matrix,omitempty"`
	Tasks      map[string]*task `yaml:"tasks,omitempty"`
}

// matrix represents the matrix configuration
type matrix struct {
	Platform   []string   `yaml:"platform,omitempty"`
	Bazel      []string   `yaml:"bazel,omitempty"`
	BuildFlags [][]string `yaml:"build_flags,omitempty"`
}

// task represents a task configuration
type task struct {
	Name         string      `yaml:"name,omitempty"`
	Platform     interface{} `yaml:"platform,omitempty"`    // can be string or template
	Bazel        interface{} `yaml:"bazel,omitempty"`       // can be string or template
	BuildFlags   interface{} `yaml:"build_flags,omitempty"` // can be []string or template string
	TestFlags    interface{} `yaml:"test_flags,omitempty"`  // can be []string or template string
	BuildTargets []string    `yaml:"build_targets,omitempty"`
	TestTargets  []string    `yaml:"test_targets,omitempty"`
}

// ReadFile reads and parses a presubmit.yml file into a Presubmit protobuf
func ReadFile(filename string) (*bzpb.Presubmit, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("reading presubmit.yml file: %v", err)
	}

	var yamlData presubmitYml
	if err := yaml.Unmarshal(data, &yamlData); err != nil {
		return nil, fmt.Errorf("parsing presubmit.yml file: %w", err)
	}

	return convertToProto(&yamlData), nil
}

// convertToProto converts the YAML structure to protobuf
func convertToProto(y *presubmitYml) *bzpb.Presubmit {
	presubmit := &bzpb.Presubmit{}

	if y.BcrTestModule != nil {
		presubmit.BcrTestModule = &bzpb.Presubmit_BcrTestModule{
			ModulePath: y.BcrTestModule.ModulePath,
		}

		if y.BcrTestModule.Matrix != nil {
			presubmit.BcrTestModule.Matrix = convertMatrix(y.BcrTestModule.Matrix)
		}

		if len(y.BcrTestModule.Tasks) > 0 {
			presubmit.BcrTestModule.Tasks = make(map[string]*bzpb.Presubmit_PresubmitTask)
			for name, task := range y.BcrTestModule.Tasks {
				presubmit.BcrTestModule.Tasks[name] = convertTask(task)
			}
		}
	}

	if y.Matrix != nil {
		presubmit.Matrix = convertMatrix(y.Matrix)
	}

	if len(y.Tasks) > 0 {
		presubmit.Tasks = make(map[string]*bzpb.Presubmit_PresubmitTask)
		for name, task := range y.Tasks {
			presubmit.Tasks[name] = convertTask(task)
		}
	}

	return presubmit
}

// convertMatrix converts matrix YAML to protobuf
func convertMatrix(m *matrix) *bzpb.Presubmit_PresubmitMatrix {
	return &bzpb.Presubmit_PresubmitMatrix{
		Platform: m.Platform,
		Bazel:    m.Bazel,
	}
}

// convertTask converts task YAML to protobuf
func convertTask(t *task) *bzpb.Presubmit_PresubmitTask {
	return &bzpb.Presubmit_PresubmitTask{
		Name:         t.Name,
		Platform:     asString(t.Platform),
		Bazel:        asString(t.Bazel),
		BuildFlags:   asStringSlice(t.BuildFlags),
		TestFlags:    asStringSlice(t.TestFlags),
		BuildTargets: t.BuildTargets,
		TestTargets:  t.TestTargets,
	}
}

// asString converts interface{} to string, handling templates
func asString(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// asStringSlice converts interface{} to []string, handling both arrays and template strings
func asStringSlice(v interface{}) []string {
	if v == nil {
		return nil
	}
	// If it's a string (template like "${{ build_flags }}"), return it as single element
	if s, ok := v.(string); ok {
		return []string{s}
	}
	// If it's already a slice, convert it
	if slice, ok := v.([]interface{}); ok {
		result := make([]string, len(slice))
		for i, item := range slice {
			if s, ok := item.(string); ok {
				result[i] = s
			}
		}
		return result
	}
	return nil
}
