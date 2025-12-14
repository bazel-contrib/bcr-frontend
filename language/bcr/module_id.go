package bcr

import (
	"fmt"
	"strings"
)

// moduleID represents a identifier of module having name name and version as
// "name@version"
type moduleID string

// moduleName is the identifier of a module
type moduleName string

// moduleVersion is the identifier of a module version
type moduleVersion string

// newModuleID creates a new ID from a name and version
func newModuleID(name, version string) moduleID {
	return moduleID(fmt.Sprintf("%s@%s", name, version))
}

func toModuleID(name moduleName, version moduleVersion) moduleID {
	return newModuleID(string(name), string(version))
}

// name returns the module name from the key
func (k moduleID) name() moduleName {
	parts := strings.SplitN(string(k), "@", 2)
	return moduleName(parts[0])
}

// version returns the version from the key
func (k moduleID) version() moduleVersion {
	parts := strings.SplitN(string(k), "@", 2)
	if len(parts) < 2 {
		return ""
	}
	return moduleVersion(parts[1])
}

// String returns the string representation of the key
func (k moduleID) String() string {
	return string(k)
}
