package bcr

import (
	"log"
	"sort"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/netutil"
	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const (
	httpFileKind                = "http_file"
	attestationRepositorySuffix = ".attestation"
	attestationDownloadedSuffix = ".intoto.jsonl"
	// http_file auto-generates a BUILD file at `<repo>/file/BUILD.bazel`
	// containing `filegroup(name = "file", srcs = [<downloaded>])`, so labels
	// must point at the `file` target inside the `file` package — not at the
	// repo root.
	attestationFilePackage    = "file"
	attestationFileTargetName = "file"
)

// attestationFetch tracks one unique .intoto.jsonl URL that needs to be fetched
// via Bazel's http_file repository rule. Multiple module-versions may reference
// the same URL (rare in practice — URLs encode filename and version), so we
// dedupe by URL here.
type attestationFetch struct {
	url       string                // canonical URL (the map key)
	integrity string                // SRI-style integrity from attestations.json (e.g. "sha256-<base64>")
	filename  string                // attestation entry filename (e.g. "source.json"); used as the http_file's downloaded_file_path stem
	refs      []attestationRuleRef  // module_attestations rules referencing this URL — used to back-propagate dead-URL status
}

// attestationRuleRef binds one module_attestations rule to one attestation
// entry filename within it. We collect these per URL so that when a URL turns
// out to be dead at Gazelle time we can simultaneously (a) drop its label from
// every referencing rule's attestations_intoto and (b) record the entry's
// filename in that rule's unavailable_entries.
type attestationRuleRef struct {
	rule     *rule.Rule
	filename string
}

// trackAttestationFetch records a per-attestation URL for later http_file
// emission. Returns the canonical label that should be added to the
// module_attestations rule's `attestations_intoto` attribute, or the empty
// label if the URL/integrity is unfit for fetching.
func (ext *bcrExtension) trackAttestationFetch(url, integrity, filename string) label.Label {
	if !ext.fetchAttestations || url == "" || integrity == "" || filename == "" {
		return label.NoLabel
	}
	// Reject anything that isn't a recognizable sha256 SRI string; http_file
	// accepts the SRI directly so we don't need to convert, just sanity-check.
	if !strings.HasPrefix(integrity, "sha256-") {
		return label.NoLabel
	}
	if existing, found := ext.attestationFetches[url]; found {
		// Same URL referenced twice: filename must agree because URLs encode
		// filenames per the BCR convention. A mismatch would let two different
		// http_file repos share content; bail loudly rather than masking a
		// data issue.
		if existing.filename != filename {
			log.Printf("warning: attestation URL %s referenced with both filename %q and %q; ignoring second occurrence", url, existing.filename, filename)
			return label.NoLabel
		}
	} else {
		ext.attestationFetches[url] = &attestationFetch{
			url:       url,
			integrity: integrity,
			filename:  filename,
		}
	}
	return makeAttestationFileLabel(url)
}

// makeAttestationRepoName derives a stable, human-readable repo name from the
// attestation URL. Strips the https:// scheme and the .intoto.jsonl extension,
// then sanitizes slashes / pluses into underscores (matching
// makeBinaryProtoRepositoryName's convention).
func makeAttestationRepoName(url string) string {
	name := strings.TrimPrefix(url, "https://")
	name = strings.TrimPrefix(name, "http://")
	name = strings.TrimSuffix(name, attestationDownloadedSuffix)
	name = sanitizeName(name)
	return name + attestationRepositorySuffix
}

// makeAttestationFileLabel returns the Bazel label that points at the
// downloaded .intoto.jsonl file produced by the http_file repo for `url`. For
// http_file the canonical target is @<repo>//file:file.
func makeAttestationFileLabel(url string) label.Label {
	return label.New(makeAttestationRepoName(url), attestationFilePackage, attestationFileTargetName)
}

// makeHttpFileRule returns an http_file rule that fetches a single
// .intoto.jsonl bundle. The downloaded_file_path encodes the original
// attestation entry filename so the downstream compile_action can recover it
// from the file's basename.
func makeHttpFileRule(fetch *attestationFetch) *rule.Rule {
	r := rule.NewRule(httpFileKind, makeAttestationRepoName(fetch.url))
	r.SetAttr("urls", []string{fetch.url})
	r.SetAttr("integrity", fetch.integrity)
	r.SetAttr("downloaded_file_path", fetch.filename+attestationDownloadedSuffix)
	return r
}

// registerAttestationRule records that a module_attestations rule references a
// set of attestation entries by filename. Must be called after the rule is
// created with the (initially optimistic) full set of attestations_intoto
// labels, so that later URL checks can back-propagate dead-URL status into the
// rule's attestations_intoto / unavailable_entries.
func (ext *bcrExtension) registerAttestationRule(r *rule.Rule, urlByFilename map[string]string) {
	for filename, url := range urlByFilename {
		fetch, ok := ext.attestationFetches[url]
		if !ok || fetch == nil {
			continue
		}
		fetch.refs = append(fetch.refs, attestationRuleRef{rule: r, filename: filename})
	}
}

// markAttestationUrlDead rewrites every module_attestations rule referencing
// `url` to drop the corresponding @<repo>//file:file label from
// attestations_intoto and append the entry's filename to unavailable_entries.
// The end effect is that build-time attestation compilation skips the dead
// entry while the resulting Attestation.Payload carries a ParseError.
func (ext *bcrExtension) markAttestationUrlDead(url string) {
	fetch, ok := ext.attestationFetches[url]
	if !ok || fetch == nil {
		return
	}
	deadLabel := makeAttestationFileLabel(url).String()
	for _, ref := range fetch.refs {
		existingLabels := ref.rule.AttrStrings("attestations_intoto")
		filtered := existingLabels[:0:0]
		for _, lbl := range existingLabels {
			if lbl != deadLabel {
				filtered = append(filtered, lbl)
			}
		}
		ref.rule.SetAttr("attestations_intoto", filtered)
		unavailable := ref.rule.AttrStrings("unavailable_entries")
		unavailable = append(unavailable, ref.filename)
		sort.Strings(unavailable)
		ref.rule.SetAttr("unavailable_entries", unavailable)
	}
}

// handleAttestationUrlStatus caches the URL status (so subsequent Gazelle runs
// skip the HEAD), and returns the http_file rule to emit when the URL is live
// or nil when it is not. Dead URLs back-propagate to referencing rules via
// markAttestationUrlDead.
func (ext *bcrExtension) handleAttestationUrlStatus(url string, status netutil.URLStatus, cached bool) *rule.Rule {
	ext.resourceStatusByUrl[url] = &bzpb.ResourceStatus{
		Url:     url,
		Code:    int32(status.Code),
		Message: status.Message,
	}
	if status.Exists() {
		return makeHttpFileRule(ext.attestationFetches[url])
	}
	cacheMsg := ""
	if cached {
		cacheMsg = " (cached)"
	}
	log.Printf("warning: attestation URL does not exist%s: %s (status: %d %s)", cacheMsg, url, status.Code, status.Message)
	ext.markAttestationUrlDead(url)
	return nil
}

// prepareAttestationRepositories materializes the tracked attestation fetches
// into a deduplicated list of http_file rules ready to be inserted into
// data/generated.MODULE.bazel. Each unique URL is first checked against the
// blacklist, then against the persistent resource-status cache, then (if still
// unknown) HEAD-fetched in parallel. URLs that fail to validate are dropped
// from the emitted set and back-propagated as unavailable_entries to the
// referencing module_attestations rules. Returns nil when fetching is
// disabled or there are no tracked URLs.
func (ext *bcrExtension) prepareAttestationRepositories() []*rule.Rule {
	if !ext.fetchAttestations || len(ext.attestationFetches) == 0 {
		return nil
	}

	// Sort URLs for deterministic order across runs.
	urls := make([]string, 0, len(ext.attestationFetches))
	for url := range ext.attestationFetches {
		urls = append(urls, url)
	}
	sort.Strings(urls)

	var (
		rules            []*rule.Rule
		uncachedURLs     []string
		blacklistedCount int
		cachedCount      int
	)

	for _, url := range urls {
		if ext.blacklistedUrls[url] {
			blacklistedCount++
			log.Printf("Skipping blacklisted attestation URL: %s", url)
			ext.markAttestationUrlDead(url)
			continue
		}
		if cachedStatus, found := ext.resourceStatusByUrl[url]; found {
			cachedCount++
			status := netutil.URLStatus{
				Code:    int(cachedStatus.Code),
				Message: cachedStatus.Message,
			}
			if r := ext.handleAttestationUrlStatus(url, status, true); r != nil {
				rules = append(rules, r)
			}
			continue
		}
		uncachedURLs = append(uncachedURLs, url)
	}

	if cachedCount > 0 {
		log.Printf("Skipped %d cached attestation URL checks", cachedCount)
	}
	if blacklistedCount > 0 {
		log.Printf("Skipped %d blacklisted attestation URLs", blacklistedCount)
	}

	if len(uncachedURLs) > 0 {
		netutil.CheckURLsParallel(
			"Checking attestation URLs",
			uncachedURLs,
			func(u string) string { return u },
			func(u string, status netutil.URLStatus) {
				if r := ext.handleAttestationUrlStatus(u, status, false); r != nil {
					rules = append(rules, r)
				}
			},
		)
	}

	log.Printf("Prepared %d http_file rules for attestation bundles", len(rules))
	return rules
}
