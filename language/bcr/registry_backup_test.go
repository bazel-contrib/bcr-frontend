package bcr

import (
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

func TestGetBackupRepositoryMetadata(t *testing.T) {
	tests := []struct {
		name     string
		registry *bzpb.Registry
		repoID   repositoryID
		want     *bzpb.RepositoryMetadata
	}{
		{
			name:     "nil registry",
			registry: nil,
			repoID:   "github:org/repo",
			want:     nil,
		},
		{
			name: "matching github repository",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "testorg",
							Name:         "testrepo",
							Description:  "Test description",
							Stargazers:   100,
						},
					},
				},
			},
			repoID: "github:testorg/testrepo",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITHUB,
				Organization: "testorg",
				Name:         "testrepo",
				Description:  "Test description",
				Stargazers:   100,
			},
		},
		{
			name: "matching gitlab repository",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITLAB,
							Organization: "gitlaborg",
							Name:         "gitlabrepo",
							Description:  "GitLab description",
						},
					},
				},
			},
			repoID: "gitlab:gitlaborg/gitlabrepo",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITLAB,
				Organization: "gitlaborg",
				Name:         "gitlabrepo",
				Description:  "GitLab description",
			},
		},
		{
			name: "no matching repository",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "testorg",
							Name:         "testrepo",
						},
					},
				},
			},
			repoID: "github:other/repo",
			want:   nil,
		},
		{
			name: "module without repository metadata",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name:               "test_module",
						RepositoryMetadata: nil,
					},
				},
			},
			repoID: "github:any/repo",
			want:   nil,
		},
		{
			name: "multiple modules, find second",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "first_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "first",
							Name:         "repo",
						},
					},
					{
						Name: "second_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "second",
							Name:         "repo",
							Stargazers:   50,
						},
					},
				},
			},
			repoID: "github:second/repo",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITHUB,
				Organization: "second",
				Name:         "repo",
				Stargazers:   50,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ext := &bcrExtension{
				backupRegistry: tt.registry,
			}
			got := ext.getBackupRepositoryMetadata(tt.repoID)

			if (got == nil) != (tt.want == nil) {
				t.Errorf("getBackupRepositoryMetadata() = %v, want %v", got, tt.want)
				return
			}

			if got != nil && tt.want != nil {
				if got.Type != tt.want.Type {
					t.Errorf("Type = %v, want %v", got.Type, tt.want.Type)
				}
				if got.Organization != tt.want.Organization {
					t.Errorf("Organization = %v, want %v", got.Organization, tt.want.Organization)
				}
				if got.Name != tt.want.Name {
					t.Errorf("Name = %v, want %v", got.Name, tt.want.Name)
				}
				if got.Description != tt.want.Description {
					t.Errorf("Description = %v, want %v", got.Description, tt.want.Description)
				}
				if got.Stargazers != tt.want.Stargazers {
					t.Errorf("Stargazers = %v, want %v", got.Stargazers, tt.want.Stargazers)
				}
			}
		})
	}
}

func TestGetBackupRepositoryMetadataForModule(t *testing.T) {
	tests := []struct {
		name       string
		registry   *bzpb.Registry
		moduleName string
		version    string
		want       *bzpb.RepositoryMetadata
	}{
		{
			name:       "nil registry",
			registry:   nil,
			moduleName: "test_module",
			version:    "1.0.0",
			want:       nil,
		},
		{
			name: "version-level metadata",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						Versions: []*bzpb.ModuleVersion{
							{
								Name:    "test_module",
								Version: "1.0.0",
								RepositoryMetadata: &bzpb.RepositoryMetadata{
									Type:         bzpb.RepositoryType_GITHUB,
									Organization: "org",
									Name:         "repo",
									Stargazers:   100,
								},
							},
						},
					},
				},
			},
			moduleName: "test_module",
			version:    "1.0.0",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITHUB,
				Organization: "org",
				Name:         "repo",
				Stargazers:   100,
			},
		},
		{
			name: "module-level metadata fallback",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "org",
							Name:         "repo",
							Description:  "Module level",
						},
						Versions: []*bzpb.ModuleVersion{
							{
								Name:    "test_module",
								Version: "1.0.0",
							},
						},
					},
				},
			},
			moduleName: "test_module",
			version:    "1.0.0",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITHUB,
				Organization: "org",
				Name:         "repo",
				Description:  "Module level",
			},
		},
		{
			name: "version not found",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						Versions: []*bzpb.ModuleVersion{
							{
								Name:    "test_module",
								Version: "1.0.0",
							},
						},
					},
				},
			},
			moduleName: "test_module",
			version:    "2.0.0",
			want:       nil,
		},
		{
			name: "module not found",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "other_module",
					},
				},
			},
			moduleName: "test_module",
			version:    "1.0.0",
			want:       nil,
		},
		{
			name: "multiple versions, find correct one",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						Versions: []*bzpb.ModuleVersion{
							{
								Name:    "test_module",
								Version: "1.0.0",
								RepositoryMetadata: &bzpb.RepositoryMetadata{
									Type:         bzpb.RepositoryType_GITHUB,
									Organization: "org",
									Name:         "repo",
									Stargazers:   50,
								},
							},
							{
								Name:    "test_module",
								Version: "2.0.0",
								RepositoryMetadata: &bzpb.RepositoryMetadata{
									Type:         bzpb.RepositoryType_GITHUB,
									Organization: "org",
									Name:         "repo",
									Stargazers:   100,
								},
							},
						},
					},
				},
			},
			moduleName: "test_module",
			version:    "2.0.0",
			want: &bzpb.RepositoryMetadata{
				Type:         bzpb.RepositoryType_GITHUB,
				Organization: "org",
				Name:         "repo",
				Stargazers:   100,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ext := &bcrExtension{
				backupRegistry: tt.registry,
			}
			got := ext.getBackupRepositoryMetadataForModule(tt.moduleName, tt.version)

			if (got == nil) != (tt.want == nil) {
				t.Errorf("getBackupRepositoryMetadataForModule() = %v, want %v", got, tt.want)
				return
			}

			if got != nil && tt.want != nil {
				if got.Type != tt.want.Type {
					t.Errorf("Type = %v, want %v", got.Type, tt.want.Type)
				}
				if got.Organization != tt.want.Organization {
					t.Errorf("Organization = %v, want %v", got.Organization, tt.want.Organization)
				}
				if got.Name != tt.want.Name {
					t.Errorf("Name = %v, want %v", got.Name, tt.want.Name)
				}
				if got.Stargazers != tt.want.Stargazers {
					t.Errorf("Stargazers = %v, want %v", got.Stargazers, tt.want.Stargazers)
				}
				if got.Description != tt.want.Description {
					t.Errorf("Description = %v, want %v", got.Description, tt.want.Description)
				}
			}
		})
	}
}

func TestPopulateFromBackupRegistry(t *testing.T) {
	tests := []struct {
		name         string
		registry     *bzpb.Registry
		repositories []*bzpb.RepositoryMetadata
		wantCount    int
		wantRepos    []*bzpb.RepositoryMetadata
	}{
		{
			name:         "nil registry",
			registry:     nil,
			repositories: []*bzpb.RepositoryMetadata{},
			wantCount:    0,
			wantRepos:    []*bzpb.RepositoryMetadata{},
		},
		{
			name:         "empty repositories",
			registry:     &bzpb.Registry{},
			repositories: []*bzpb.RepositoryMetadata{},
			wantCount:    0,
			wantRepos:    []*bzpb.RepositoryMetadata{},
		},
		{
			name: "populate single repository",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:            bzpb.RepositoryType_GITHUB,
							Organization:    "testorg",
							Name:            "testrepo",
							Description:     "Full description",
							Stargazers:      200,
							PrimaryLanguage: "Go",
							CanonicalName:   "testorg/testrepo",
							Languages: map[string]int32{
								"Go":   1000,
								"Java": 500,
							},
						},
					},
				},
			},
			repositories: []*bzpb.RepositoryMetadata{
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "testorg",
					Name:         "testrepo",
				},
			},
			wantCount: 1,
			wantRepos: []*bzpb.RepositoryMetadata{
				{
					Type:            bzpb.RepositoryType_GITHUB,
					Organization:    "testorg",
					Name:            "testrepo",
					Description:     "Full description",
					Stargazers:      200,
					PrimaryLanguage: "Go",
					CanonicalName:   "testorg/testrepo",
					Languages: map[string]int32{
						"Go":   1000,
						"Java": 500,
					},
				},
			},
		},
		{
			name: "partial populate - preserve existing data",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "testorg",
							Name:         "testrepo",
							Description:  "New description",
							Stargazers:   300,
						},
					},
				},
			},
			repositories: []*bzpb.RepositoryMetadata{
				{
					Type:            bzpb.RepositoryType_GITHUB,
					Organization:    "testorg",
					Name:            "testrepo",
					Description:     "Old description",
					Stargazers:      100,
					PrimaryLanguage: "Existing",
				},
			},
			wantCount: 1,
			wantRepos: []*bzpb.RepositoryMetadata{
				{
					Type:            bzpb.RepositoryType_GITHUB,
					Organization:    "testorg",
					Name:            "testrepo",
					Description:     "New description",
					Stargazers:      300,
					PrimaryLanguage: "Existing",
				},
			},
		},
		{
			name: "no matching repository in backup",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "test_module",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "other",
							Name:         "repo",
						},
					},
				},
			},
			repositories: []*bzpb.RepositoryMetadata{
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "testorg",
					Name:         "testrepo",
					Description:  "Original",
				},
			},
			wantCount: 0,
			wantRepos: []*bzpb.RepositoryMetadata{
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "testorg",
					Name:         "testrepo",
					Description:  "Original",
				},
			},
		},
		{
			name: "multiple repositories, partial match",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "module1",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "org1",
							Name:         "repo1",
							Stargazers:   100,
						},
					},
				},
			},
			repositories: []*bzpb.RepositoryMetadata{
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org1",
					Name:         "repo1",
				},
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org2",
					Name:         "repo2",
				},
			},
			wantCount: 1,
			wantRepos: []*bzpb.RepositoryMetadata{
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org1",
					Name:         "repo1",
					Stargazers:   100,
				},
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org2",
					Name:         "repo2",
				},
			},
		},
		{
			name: "skip nil repository",
			registry: &bzpb.Registry{
				Modules: []*bzpb.Module{
					{
						Name: "module1",
						RepositoryMetadata: &bzpb.RepositoryMetadata{
							Type:         bzpb.RepositoryType_GITHUB,
							Organization: "org1",
							Name:         "repo1",
							Stargazers:   100,
						},
					},
				},
			},
			repositories: []*bzpb.RepositoryMetadata{
				nil,
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org1",
					Name:         "repo1",
				},
			},
			wantCount: 1,
			wantRepos: []*bzpb.RepositoryMetadata{
				nil,
				{
					Type:         bzpb.RepositoryType_GITHUB,
					Organization: "org1",
					Name:         "repo1",
					Stargazers:   100,
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ext := &bcrExtension{
				backupRegistry: tt.registry,
			}

			got := ext.populateFromBackupRegistry(tt.repositories)

			if got != tt.wantCount {
				t.Errorf("populateFromBackupRegistry() count = %v, want %v", got, tt.wantCount)
			}

			// Verify the repositories were updated correctly
			for i, repo := range tt.repositories {
				if repo == nil {
					continue
				}
				want := tt.wantRepos[i]
				if want == nil {
					continue
				}

				if repo.Description != want.Description {
					t.Errorf("repositories[%d].Description = %v, want %v", i, repo.Description, want.Description)
				}
				if repo.Stargazers != want.Stargazers {
					t.Errorf("repositories[%d].Stargazers = %v, want %v", i, repo.Stargazers, want.Stargazers)
				}
				if repo.PrimaryLanguage != want.PrimaryLanguage {
					t.Errorf("repositories[%d].PrimaryLanguage = %v, want %v", i, repo.PrimaryLanguage, want.PrimaryLanguage)
				}
				if repo.CanonicalName != want.CanonicalName {
					t.Errorf("repositories[%d].CanonicalName = %v, want %v", i, repo.CanonicalName, want.CanonicalName)
				}

				if len(repo.Languages) != len(want.Languages) {
					t.Errorf("repositories[%d].Languages length = %v, want %v", i, len(repo.Languages), len(want.Languages))
				}
				for lang, bytes := range want.Languages {
					if repo.Languages[lang] != bytes {
						t.Errorf("repositories[%d].Languages[%s] = %v, want %v", i, lang, repo.Languages[lang], bytes)
					}
				}
			}
		})
	}
}
