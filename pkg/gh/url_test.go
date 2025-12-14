package gh

import (
	"testing"
)

func TestParseGitHubSourceURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		want    *SourceURLInfo
		wantErr bool
	}{
		{
			name: "tag archive with tar.gz",
			url:  "https://github.com/google/glog/archive/refs/tags/v0.7.1.tar.gz",
			want: &SourceURLInfo{
				Organization: "google",
				Repository:   "glog",
				Type:         URLTypeTag,
				Reference:    "v0.7.1",
			},
			wantErr: false,
		},
		{
			name: "tag archive with zip",
			url:  "https://github.com/grpc/grpc/archive/refs/tags/v1.41.0.zip",
			want: &SourceURLInfo{
				Organization: "grpc",
				Repository:   "grpc",
				Type:         URLTypeTag,
				Reference:    "v1.41.0",
			},
			wantErr: false,
		},
		{
			name: "boost tag archive",
			url:  "https://github.com/boostorg/smart_ptr/archive/refs/tags/boost-1.87.0.tar.gz",
			want: &SourceURLInfo{
				Organization: "boostorg",
				Repository:   "smart_ptr",
				Type:         URLTypeTag,
				Reference:    "boost-1.87.0",
			},
			wantErr: false,
		},
		{
			name: "commit SHA archive",
			url:  "https://github.com/grpc/grpc/archive/b73dbd94df4bd9f9362d16b76f34e4c7c2358409.tar.gz",
			want: &SourceURLInfo{
				Organization: "grpc",
				Repository:   "grpc",
				Type:         URLTypeCommitSHA,
				Reference:    "b73dbd94df4bd9f9362d16b76f34e4c7c2358409",
			},
			wantErr: false,
		},
		{
			name: "release download",
			url:  "https://github.com/fmeum/rules_jni/releases/download/v0.11.1/rules_jni-v0.11.1.tar.gz",
			want: &SourceURLInfo{
				Organization: "fmeum",
				Repository:   "rules_jni",
				Type:         URLTypeRelease,
				Reference:    "v0.11.1",
			},
			wantErr: false,
		},
		{
			name: "release download with different naming",
			url:  "https://github.com/sergeykhliustin/BazelPods/releases/download/1.12.5/release.tar.gz",
			want: &SourceURLInfo{
				Organization: "sergeykhliustin",
				Repository:   "BazelPods",
				Type:         URLTypeRelease,
				Reference:    "1.12.5",
			},
			wantErr: false,
		},
		{
			name: "rules_closure release",
			url:  "https://github.com/bazelbuild/rules_closure/releases/download/0.15.0/rules_closure-0.15.0.tar.gz",
			want: &SourceURLInfo{
				Organization: "bazelbuild",
				Repository:   "rules_closure",
				Type:         URLTypeRelease,
				Reference:    "0.15.0",
			},
			wantErr: false,
		},
		{
			name:    "invalid URL - not github",
			url:     "https://example.com/foo/bar.tar.gz",
			want:    nil,
			wantErr: true,
		},
		{
			name:    "invalid URL - wrong pattern",
			url:     "https://github.com/foo/bar/blob/main/file.txt",
			want:    nil,
			wantErr: true,
		},
		{
			name:    "invalid URL - incomplete",
			url:     "https://github.com/foo",
			want:    nil,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseGitHubSourceURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Errorf("ParseGitHubSourceURL() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.wantErr {
				return
			}
			if got.Organization != tt.want.Organization {
				t.Errorf("ParseGitHubSourceURL() Organization = %v, want %v", got.Organization, tt.want.Organization)
			}
			if got.Repository != tt.want.Repository {
				t.Errorf("ParseGitHubSourceURL() Repository = %v, want %v", got.Repository, tt.want.Repository)
			}
			if got.Type != tt.want.Type {
				t.Errorf("ParseGitHubSourceURL() Type = %v, want %v", got.Type, tt.want.Type)
			}
			if got.Reference != tt.want.Reference {
				t.Errorf("ParseGitHubSourceURL() Reference = %v, want %v", got.Reference, tt.want.Reference)
			}
		})
	}
}

func TestIsGitHubURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{
			name: "valid github URL",
			url:  "https://github.com/foo/bar/archive/v1.0.0.tar.gz",
			want: true,
		},
		{
			name: "github.com in path but not host",
			url:  "https://example.com/github.com/foo.tar.gz",
			want: false,
		},
		{
			name: "non-github URL",
			url:  "https://gitlab.com/foo/bar/archive/v1.0.0.tar.gz",
			want: false,
		},
		{
			name: "http instead of https",
			url:  "http://github.com/foo/bar/archive/v1.0.0.tar.gz",
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsGitHubURL(tt.url); got != tt.want {
				t.Errorf("IsGitHubURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestURLTypeString(t *testing.T) {
	tests := []struct {
		name string
		ut   URLType
		want string
	}{
		{
			name: "tag",
			ut:   URLTypeTag,
			want: "tag",
		},
		{
			name: "commit_sha",
			ut:   URLTypeCommitSHA,
			want: "commit_sha",
		},
		{
			name: "release",
			ut:   URLTypeRelease,
			want: "release",
		},
		{
			name: "unknown",
			ut:   URLTypeUnknown,
			want: "unknown",
		},
		{
			name: "invalid type",
			ut:   URLType(999),
			want: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.ut.String(); got != tt.want {
				t.Errorf("URLType.String() = %v, want %v", got, tt.want)
			}
		})
	}
}
