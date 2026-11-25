package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

type cacheOptions struct {
	listen, dir, upstream         string
	maxBytes                      int64
	archiveAfter                  time.Duration
	archiveCache, archiveInstance string
}

func registerCacheFlags() *cacheOptions {
	cache := new(cacheOptions)
	flag.StringVar(&cache.listen, "cache_listen", "", "optional address for the plaintext instrumented remote cache")
	flag.StringVar(&cache.dir, "cache_dir", "", "file-backed remote cache directory")
	flag.Int64Var(&cache.maxBytes, "cache_max_bytes", 0, "local cache disk budget in bytes (0 disables eviction)")
	flag.DurationVar(&cache.archiveAfter, "archive_after", 0, "archive completed runs after this age (for example 720h)")
	flag.StringVar(&cache.archiveCache, "archive_cache", "", "non-evicting archive cache URL (grpc:// or grpcs://)")
	flag.StringVar(&cache.archiveInstance, "archive_instance", "", "dedicated REAPI CAS instance for archived events")
	flag.StringVar(&cache.upstream, "cache_upstream", "", "upstream remote cache URL (grpc:// or grpcs://)")
	return cache
}

func (cache *cacheOptions) validate(useJournal bool) error {
	if (cache.listen != "") != (cache.dir != "" || cache.upstream != "") || (cache.dir != "" && cache.upstream != "") {
		return errors.New("--cache_listen requires exactly one of --cache_dir or --cache_upstream")
	}
	if cache.maxBytes < 0 || (cache.maxBytes > 0 && cache.dir == "") {
		return errors.New("--cache_max_bytes must be nonnegative and requires --cache_dir when set")
	}
	if cache.listen != "" && useJournal {
		return errors.New("instrumented remote cache requires SQLite storage")
	}
	if cache.archiveAfter < 0 || (cache.archiveAfter > 0 && cache.archiveCache == "") ||
		((cache.archiveCache == "") != (cache.archiveInstance == "")) || (cache.archiveCache != "" && useJournal) {
		return errors.New("archival requires SQLite, --archive_cache and --archive_instance; use --archive_after to enable offloading")
	}
	return nil
}

func (cache *cacheOptions) openArchive() (invocation.BlobArchive, func(), error) {
	if cache.archiveCache == "" {
		return nil, func() {}, nil
	}
	conn, err := dialCache(cache.archiveCache)
	if err != nil {
		return nil, nil, fmt.Errorf("archive cache: %w", err)
	}
	archive, err := remotecache.NewBlobArchive(conn, cache.archiveInstance)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	return archive, func() { conn.Close() }, nil
}

func (cache *cacheOptions) start(store *invocation.Store, logger *log.Logger, serveErrors chan<- error) (*grpc.Server, func(), error) {
	if cache.listen == "" {
		return nil, func() {}, nil
	}
	backend, closeBackend, err := cacheBackend(cache.dir, cache.upstream, cache.maxBytes)
	if err != nil {
		return nil, nil, err
	}
	listener, err := net.Listen("tcp", cache.listen)
	if err != nil {
		closeBackend()
		return nil, nil, err
	}
	server := remotecache.NewServer(backend, store.ObserveRemoteCache, logger)
	go func() { serveErrors <- server.Serve(listener) }()
	if cache.maxBytes > 0 {
		logger.Printf("remote cache disk budget: %d bytes (LRU)", cache.maxBytes)
	}
	logger.Printf("remote cache listening on %s (Bazel --remote_cache=grpc://%s)", listener.Addr(), listener.Addr())
	return server, func() {
		listener.Close()
		closeBackend()
	}, nil
}

func cacheBackend(dir, upstream string, maxBytes int64) (remotecache.Backend, func(), error) {
	if maxBytes > 0 {
		backend, err := remotecache.NewBoundedFileCache(dir, maxBytes)
		if err != nil {
			return nil, nil, err
		}
		return backend, func() { backend.Close() }, nil
	}
	if dir != "" {
		backend, err := remotecache.NewFileCache(dir)
		return backend, func() {}, err
	}
	conn, err := dialCache(upstream)
	if err != nil {
		return nil, nil, err
	}
	return remotecache.NewProxy(conn, strings.HasPrefix(strings.ToLower(upstream), "grpcs://")), func() { conn.Close() }, nil
}

func dialCache(upstream string) (*grpc.ClientConn, error) {
	endpoint, err := url.Parse(upstream)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("expected grpc://host[:port] or grpcs://host[:port]")
	}
	var transport credentials.TransportCredentials
	port := endpoint.Port()
	switch endpoint.Scheme {
	case "grpc":
		transport = insecure.NewCredentials()
		if port == "" {
			port = "80"
		}
	case "grpcs":
		transport = credentials.NewTLS(&tls.Config{ServerName: endpoint.Hostname(), MinVersion: tls.VersionTLS12})
		if port == "" {
			port = "443"
		}
	default:
		return nil, errors.New("cache scheme must be grpc or grpcs")
	}
	target := net.JoinHostPort(endpoint.Hostname(), port)
	return grpc.NewClient(target, grpc.WithTransportCredentials(transport),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(remotecache.MaxMessageBytes),
			grpc.MaxCallSendMsgSize(remotecache.MaxMessageBytes)))
}
