package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	"github.com/bazel-contrib/bcr-frontend/pkg/remoteexecution"
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
	flag.StringVar(&cache.listen, "remote_cache_grpc_listen", "", "optional address for the plaintext instrumented remote cache")
	flag.StringVar(&cache.dir, "remote_cache_dir", "", "file-backed remote cache directory")
	flag.Int64Var(&cache.maxBytes, "remote_cache_max_bytes", 0, "local cache disk budget in bytes (0 disables eviction)")
	flag.DurationVar(&cache.archiveAfter, "remote_cache_archive_after", 0, "archive completed runs after this age (for example 720h)")
	flag.StringVar(&cache.archiveCache, "remote_cache_archive_url", "", "non-evicting archive cache URL (grpc:// or grpcs://)")
	flag.StringVar(&cache.archiveInstance, "remote_cache_archive_instance", "", "dedicated REAPI CAS instance for archived events")
	flag.StringVar(&cache.upstream, "remote_cache_backend", "", "upstream remote cache URL (grpc:// or grpcs://)")
	flag.StringVar(&cache.upstream, "remote_cache_upstream", "", "deprecated alias for --remote_cache_backend")
	return cache
}

func (cache *cacheOptions) validate(useJournal bool) error {
	if (cache.listen != "") != (cache.dir != "" || cache.upstream != "") || (cache.dir != "" && cache.upstream != "") {
		return errors.New("--remote_cache_grpc_listen requires exactly one of --remote_cache_dir or --remote_cache_backend")
	}
	if cache.maxBytes < 0 || (cache.maxBytes > 0 && cache.dir == "") {
		return errors.New("--remote_cache_max_bytes must be nonnegative and requires --remote_cache_dir when set")
	}
	if cache.listen != "" && useJournal {
		return errors.New("instrumented remote cache requires SQLite storage")
	}
	if cache.archiveAfter < 0 || (cache.archiveAfter > 0 && cache.archiveCache == "") ||
		((cache.archiveCache == "") != (cache.archiveInstance == "")) || (cache.archiveCache != "" && useJournal) {
		return errors.New("archival requires SQLite, --remote_cache_archive_url and --remote_cache_archive_instance; use --remote_cache_archive_after to enable offloading")
	}
	return nil
}

func (cache *cacheOptions) openArchive() (invocation.BlobArchive, func(), error) {
	if cache.archiveCache == "" {
		return nil, func() {}, nil
	}
	conn, err := dialBackend(cache.archiveCache)
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

type executionOptions struct {
	config       string
	clientToken  string
	viewerToken  string
	adminToken   string
	database     string
	grpcListen   string
	cacheDir     string
	workerListen string
	backend      string
	httpBackend  string
}

func registerExecutionFlags() *executionOptions {
	options := new(executionOptions)
	flag.StringVar(&options.config, "remote_execution_config", "", "enable remote execution with this JSON pool and credential configuration")
	flag.StringVar(&options.clientToken, "remote_execution_client_token_file", "", "private token file for Bazel remote execution")
	flag.StringVar(&options.viewerToken, "remote_execution_viewer_token_file", "", "private token file for the remote execution viewer")
	flag.StringVar(&options.adminToken, "remote_execution_admin_token_file", "", "private token file for configuring remote execution pools")
	flag.StringVar(&options.database, "remote_execution_sqlite", "execution.sqlite", "path to the remote execution SQLite database")
	flag.StringVar(&options.grpcListen, "remote_execution_grpc_listen", "", "optional dedicated loopback gRPC listener for authenticated remote execution and its cache")
	flag.StringVar(&options.cacheDir, "remote_execution_cache_dir", "", "cache directory for the dedicated execution listener (defaults to the SQLite path plus .cache)")
	flag.StringVar(&options.workerListen, "remote_execution_http_listen", "", "optional loopback HTTP listener for the Iroh worker gateway")
	flag.StringVar(&options.backend, "remote_execution_backend", "", "upstream remote execution and CAS gRPC URL (grpc:// or grpcs://)")
	flag.StringVar(&options.httpBackend, "remote_execution_http_backend", "", "upstream scheduler HTTP origin for observer, admin, and worker APIs")
	return options
}

func (options *executionOptions) enabled() bool {
	return options.config != "" || options.clientToken != "" || options.viewerToken != "" || options.adminToken != ""
}

func (options *executionOptions) dedicatedCache(cache *cacheOptions) (*cacheOptions, error) {
	if options.backend != "" {
		if options.grpcListen == "" || options.enabled() || options.cacheDir != "" {
			return nil, errors.New("--remote_execution_backend requires --remote_execution_grpc_listen and uses upstream credentials and cache storage")
		}
		return nil, nil
	}
	if options.grpcListen == "" {
		if options.cacheDir != "" {
			return nil, errors.New("--remote_execution_cache_dir requires --remote_execution_grpc_listen")
		}
		return nil, nil
	}
	if !options.enabled() {
		return nil, errors.New("--remote_execution_grpc_listen requires remote execution credentials")
	}
	dir := options.cacheDir
	if dir == "" {
		dir = options.database + ".cache"
	}
	if cache.dir != "" {
		if err := checkCacheDirectories(cache.dir, dir); err != nil {
			return nil, err
		}
	}
	return &cacheOptions{listen: options.grpcListen, dir: dir}, nil
}

func checkCacheDirectories(cacheDir, executionDir string) error {
	dirs := []string{cacheDir, executionDir}
	for i, dir := range dirs {
		absolute, err := filepath.Abs(dir)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(absolute, 0700); err != nil {
			return err
		}
		dirs[i], err = filepath.EvalSymlinks(absolute)
		if err != nil {
			return err
		}
	}
	for i, dir := range dirs {
		relative, err := filepath.Rel(dir, dirs[1-i])
		if err != nil {
			return err
		}
		if relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New("remote execution requires a cache directory separate from --remote_cache_dir")
		}
	}
	return nil
}

func (options *executionOptions) loadConfig() (remoteexecution.Config, error) {
	var config remoteexecution.Config
	if options.config != "" {
		if options.clientToken != "" || options.viewerToken != "" || options.adminToken != "" {
			return config, errors.New("choose --remote_execution_config or the execution token file flags")
		}
		return remoteexecution.LoadConfig(options.config)
	}
	for _, file := range []struct {
		path  string
		token *string
	}{
		{options.clientToken, &config.ClientToken},
		{options.viewerToken, &config.ViewerToken},
		{options.adminToken, &config.AdminToken},
	} {
		if file.path == "" {
			return config, errors.New("remote execution requires client, viewer, and admin token files")
		}
		data, err := os.ReadFile(file.path)
		if err != nil {
			return config, err
		}
		*file.token = strings.TrimSpace(string(data))
	}
	return config, nil
}

func (cache *cacheOptions) start(store *invocation.Store, execution *executionOptions, logger *log.Logger, serveErrors chan<- error) (*grpc.Server, *remoteexecution.Scheduler, *remotecache.Monitor, func(), error) {
	if cache.listen == "" {
		if execution.enabled() {
			return nil, nil, nil, nil, errors.New("remote execution requires --remote_execution_grpc_listen or a configured remote cache listener")
		}
		return nil, nil, nil, func() {}, nil
	}
	backend, closeBackend, err := cacheBackend(cache.dir, cache.upstream, cache.maxBytes)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	listener, err := net.Listen("tcp", cache.listen)
	if err != nil {
		closeBackend()
		return nil, nil, nil, nil, err
	}
	monitor := remotecache.NewMonitor(backend)
	var scheduler *remoteexecution.Scheduler
	closeAll := func() {
		listener.Close()
		if scheduler != nil {
			scheduler.Close()
		}
		closeBackend()
	}
	if execution.enabled() {
		if !listener.Addr().(*net.TCPAddr).IP.IsLoopback() {
			closeAll()
			return nil, nil, nil, nil, errors.New("terminate TLS at a local proxy and bind the execution cache listener to loopback")
		}
		config, err := execution.loadConfig()
		if err != nil {
			closeAll()
			return nil, nil, nil, nil, fmt.Errorf("load execution configuration: %w", err)
		}
		scheduler, err = remoteexecution.Open(execution.database, config, backend)
		if err != nil {
			closeAll()
			return nil, nil, nil, nil, fmt.Errorf("open execution scheduler: %w", err)
		}
		backend = scheduler
	}
	var serverOptions []grpc.ServerOption
	if scheduler != nil {
		serverOptions = scheduler.ServerOptions()
	}
	serverOptions = append(serverOptions, grpc.StatsHandler(monitor))
	server := remotecache.NewServer(backend, store.ObserveRemoteCache, logger, serverOptions...)
	if scheduler != nil {
		scheduler.RegisterREAPI(server)
		logger.Printf("remote execution enabled on %s", listener.Addr())
	}
	go func() { serveErrors <- server.Serve(listener) }()
	if cache.maxBytes > 0 {
		logger.Printf("remote cache disk budget: %d bytes (LRU)", cache.maxBytes)
	}
	if execution.grpcListen == "" {
		logger.Printf("remote cache listening on %s (Bazel --remote_cache=grpc://%s)", listener.Addr(), listener.Addr())
	}
	return server, scheduler, monitor, closeAll, nil
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
	conn, err := dialBackend(upstream)
	if err != nil {
		return nil, nil, err
	}
	return remotecache.NewProxy(conn, trustedBackendLink(upstream)), func() { conn.Close() }, nil
}

func trustedBackendLink(address string) bool {
	target, err := url.Parse(address)
	if err != nil {
		return false
	}
	return target.Scheme == "grpcs" || target.Scheme == "https" || target.Hostname() == "localhost" ||
		net.ParseIP(target.Hostname()).IsLoopback()
}

func dialBackend(upstream string) (*grpc.ClientConn, error) {
	endpoint, err := url.Parse(upstream)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.ForceQuery || endpoint.RawQuery != "" || endpoint.Fragment != "" {
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
		return nil, errors.New("grpc backend scheme must be grpc or grpcs")
	}
	target := net.JoinHostPort(endpoint.Hostname(), port)
	return grpc.NewClient(target, grpc.WithTransportCredentials(transport),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(remotecache.MaxMessageBytes),
			grpc.MaxCallSendMsgSize(remotecache.MaxMessageBytes)))
}
