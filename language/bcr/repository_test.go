package bcr

import (
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

func TestParseRepository(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantOrg  string
		wantName string
		wantType bzpb.RepositoryType
		wantOk   bool
	}{
		// GitHub formats
		{
			name:     "github prefix",
			input:    "github:boostorg/qvm",
			wantOrg:  "boostorg",
			wantName: "qvm",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "https github",
			input:    "https://github.com/tweag/rules_sh",
			wantOrg:  "tweag",
			wantName: "rules_sh",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "http github",
			input:    "http://github.com/Vertexwahn/rules_qt6",
			wantOrg:  "Vertexwahn",
			wantName: "rules_qt6",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "github with trailing slash",
			input:    "github:google/snappy/",
			wantOrg:  "google",
			wantName: "snappy",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "github with .git suffix",
			input:    "github:bazelbuild/bazel-skylib.git",
			wantOrg:  "bazelbuild",
			wantName: "bazel-skylib",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "github with query params",
			input:    "github:google/re2?ref=main",
			wantOrg:  "google",
			wantName: "re2",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		{
			name:     "github with fragment",
			input:    "github:abseil/abseil-cpp#hash",
			wantOrg:  "abseil",
			wantName: "abseil-cpp",
			wantType: bzpb.RepositoryType_GITHUB,
			wantOk:   true,
		},
		// GitLab formats (currently REPOSITORY_TYPE_UNKNOWN)
		{
			name:     "gitlab prefix",
			input:    "gitlab:arm-bazel/ape",
			wantOrg:  "arm-bazel",
			wantName: "ape",
			wantType: bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN,
			wantOk:   true,
		},
		{
			name:     "https gitlab",
			input:    "https://gitlab.arm.com/bazel/ape",
			wantOrg:  "bazel",
			wantName: "ape",
			wantType: bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN,
			wantOk:   true,
		},
		{
			name:     "https gitlab freedesktop",
			input:    "https://gitlab.freedesktop.org/xorg/lib/libxtrans",
			wantOrg:  "xorg",
			wantName: "lib/libxtrans",
			wantType: bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN,
			wantOk:   true,
		},
		// Invalid formats
		{
			name:   "non-git url",
			input:  "https://download.redis.io/releases",
			wantOk: false,
		},
		{
			name:   "non-git domain",
			input:  "https://zlib.net/pigz",
			wantOk: false,
		},
		{
			name:   "aomedia googlesource",
			input:  "https://aomedia.googlesource.com/aom/",
			wantOk: false,
		},
		{
			name:   "ftp url",
			input:  "https://ftp.gnu.org/gnu/glpk",
			wantOk: false,
		},
		{
			name:   "download url",
			input:  "https://storage.googleapis.com/google-code-archive-downloads",
			wantOk: false,
		},
		{
			name:   "plain http",
			input:  "http://www.tcs.hut.fi/Software/bliss",
			wantOk: false,
		},
		{
			name:   "lttng url",
			input:  "https://lttng.org/files/urcu",
			wantOk: false,
		},
		{
			name:   "sourceforge",
			input:  "https://download.sourceforge.net/project/tcl/Tcl/",
			wantOk: false,
		},
		{
			name:   "sqlite",
			input:  "https://sqlite.org",
			wantOk: false,
		},
		{
			name:   "bcr url",
			input:  "https://bcr.bazel.build",
			wantOk: false,
		},
		{
			name:   "empty string",
			input:  "",
			wantOk: false,
		},
		{
			name:   "only prefix",
			input:  "github:",
			wantOk: false,
		},
		{
			name:   "missing repo name",
			input:  "github:google",
			wantOk: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			md, ok := parseRepositoryMetadataFromRepositoryString(tt.input)

			if ok != tt.wantOk {
				t.Errorf("parseRepository(%q) ok = %v, want %v", tt.input, ok, tt.wantOk)
				return
			}

			if !ok {
				return
			}

			if md.Organization != tt.wantOrg {
				t.Errorf("parseRepository(%q) org = %q, want %q", tt.input, md.Organization, tt.wantOrg)
			}

			if md.Name != tt.wantName {
				t.Errorf("parseRepository(%q) name = %q, want %q", tt.input, md.Name, tt.wantName)
			}

			if md.Type != tt.wantType {
				t.Errorf("parseRepository(%q) type = %v, want %v", tt.input, md.Type, tt.wantType)
			}
		})
	}
}
