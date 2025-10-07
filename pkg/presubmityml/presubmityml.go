package presubmityml

import (
	"fmt"
	"os"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
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
	Platform []string `yaml:"platform,omitempty"`
	Bazel    []string `yaml:"bazel,omitempty"`
}

// task represents a task configuration
type task struct {
	Name         string   `yaml:"name,omitempty"`
	Platform     string   `yaml:"platform,omitempty"`
	Bazel        string   `yaml:"bazel,omitempty"`
	BuildFlags   []string `yaml:"build_flags,omitempty"`
	TestFlags    []string `yaml:"test_flags,omitempty"`
	BuildTargets []string `yaml:"build_targets,omitempty"`
	TestTargets  []string `yaml:"test_targets,omitempty"`
}

// ReadFile reads and parses a presubmit.yml file into a Presubmit protobuf
func ReadFile(filename string) (*bzpb.Presubmit, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("reading presubmit.yml file: %v", err)
	}

	var yamlData presubmitYml
	if err := yaml.Unmarshal(data, &yamlData); err != nil {
		return nil, fmt.Errorf("parsing presubmit.yml file: %v", err)
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
		Platform:     t.Platform,
		Bazel:        t.Bazel,
		BuildFlags:   t.BuildFlags,
		TestFlags:    t.TestFlags,
		BuildTargets: t.BuildTargets,
		TestTargets:  t.TestTargets,
	}
}
