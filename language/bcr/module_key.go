package bcr

import (
	"fmt"
	"strings"
)

// moduleKey represents a module name and version as "name@version"
type moduleKey string

// newModuleKey creates a new moduleKey from a name and version
func newModuleKey(name, version string) moduleKey {
	return moduleKey(fmt.Sprintf("%s@%s", name, version))
}

// name returns the module name from the key
func (k moduleKey) name() string {
	parts := strings.SplitN(string(k), "@", 2)
	return parts[0]
}

// version returns the version from the key
func (k moduleKey) version() string {
	parts := strings.SplitN(string(k), "@", 2)
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

// String returns the string representation of the key
func (k moduleKey) String() string {
	return string(k)
}
