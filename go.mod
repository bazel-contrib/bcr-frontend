module github.com/bazel-contrib/bcr-frontend

go 1.26.0

require (
	github.com/JohannesKaufmann/html-to-markdown v1.6.0
	github.com/bazelbuild/bazel-gazelle v0.47.0
	github.com/bazelbuild/bazelisk v1.27.0
	github.com/bazelbuild/buildtools v0.0.0-20260319080235-05d2ebe49b0f
	github.com/bazelbuild/remote-apis v0.0.0-20251110153243-3860ca2d3e55
	github.com/chromedp/cdproto v0.0.0-20250724212937-08a3db8b4327
	github.com/chromedp/chromedp v0.14.2
	github.com/dominikbraun/graph v0.23.0
	github.com/google/go-github/v66 v66.0.0
	github.com/junkblocker/codesearch v1.4.0
	github.com/samthor/sre2 v0.0.0-20150929104051-385a11de6465
	github.com/schollz/progressbar/v3 v3.19.0
	github.com/shurcooL/githubv4 v0.0.0-20260209031235-2402fdf4a9ed
	github.com/teacat/noire v1.1.0
	github.com/zeebo/blake3 v0.2.4
	go.starlark.net v0.0.0-20260326113308-fadfc96def35
	golang.org/x/oauth2 v0.36.0
	golang.org/x/sync v0.20.0
	golang.org/x/term v0.43.0
	golang.org/x/time v0.14.0
	google.golang.org/genproto/googleapis/api v0.0.0-20260526163538-3dc84a4a5aaa
	google.golang.org/genproto/googleapis/bytestream v0.0.0-20250707201910-8d1bb00bc6a7
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261123191846-1e707ab9fbc2
	google.golang.org/grpc v1.83.1
	google.golang.org/protobuf v1.36.12
	gopkg.in/yaml.v3 v3.0.1
	modernc.org/sqlite v1.46.1
)

require (
	cloud.google.com/go/longrunning v0.5.12 // indirect
	github.com/PuerkitoBio/goquery v1.9.2 // indirect
	github.com/andybalholm/cascadia v1.3.2 // indirect
	github.com/bazel-contrib/bcr-frontend/proto/build v0.0.0
	github.com/bazel-contrib/bcr-frontend/proto/buildeventstream v0.0.0
	github.com/bazel-contrib/bcr-frontend/proto/failure_details v0.0.0 // indirect
	github.com/bgentry/go-netrc v0.0.0-20140422174119-9fd32a8b3d3d // indirect
	github.com/chromedp/sysutil v1.1.0 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/go-json-experiment/json v0.0.0-20250725192818-e39067aee2d2 // indirect
	github.com/gobwas/httphead v0.1.0 // indirect
	github.com/gobwas/pool v0.2.1 // indirect
	github.com/gobwas/ws v1.4.0 // indirect
	github.com/gofrs/flock v0.12.1 // indirect
	github.com/google/go-querystring v1.1.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/hashicorp/go-version v1.7.0 // indirect
	github.com/klauspost/cpuid/v2 v2.0.12 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mitchellh/colorstring v0.0.0-20190213212951-d06e56a500db // indirect
	github.com/mitchellh/go-homedir v1.1.0 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/rogpeppe/go-internal v1.14.1 // indirect
	github.com/shurcooL/graphql v0.0.0-20230722043721-ed46e5a46466 // indirect
	golang.org/x/exp v0.0.0-20251023183803-a4bb9ffd2546 // indirect
	golang.org/x/mod v0.35.0 // indirect
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	golang.org/x/tools/go/vcs v0.1.0-deprecated // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

replace github.com/bazel-contrib/bcr-frontend/proto/build => ./genproto/github.com/bazel-contrib/bcr-frontend/proto/build

replace github.com/bazel-contrib/bcr-frontend/proto/buildeventstream => ./genproto/github.com/bazel-contrib/bcr-frontend/proto/buildeventstream

replace github.com/bazel-contrib/bcr-frontend/proto/failure_details => ./genproto/github.com/bazel-contrib/bcr-frontend/proto/failure_details
