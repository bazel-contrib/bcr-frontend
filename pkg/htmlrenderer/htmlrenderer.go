package htmlrenderer

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/amenzhinsky/go-memexec"
	"github.com/rs/zerolog"

	rnpb "github.com/bazel-contrib/bcr-frontend/build/stack/centrl/render/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/fsutil"
	"github.com/bazel-contrib/bcr-frontend/pkg/netutil"
)

const (
	contentTypeJSON = "application/json"
	// debugRender is a debug flag for use by a developer
	debugRender = false
)

type HtmlRendererOption func(*HtmlRenderer) *HtmlRenderer

func WithHttpPort(port int) HtmlRendererOption {
	return func(sp *HtmlRenderer) *HtmlRenderer {
		sp.httpPort = port
		return sp
	}
}

func WithHttpClientTimeout(timeout time.Duration) HtmlRendererOption {
	return func(sp *HtmlRenderer) *HtmlRenderer {
		sp.httpClientTimout = timeout
		return sp
	}
}

func WithLogger(logger zerolog.Logger) HtmlRendererOption {
	return func(sp *HtmlRenderer) *HtmlRenderer {
		sp.logger = logger
		return sp
	}
}

var defaultOptions = []HtmlRendererOption{
	WithHttpPort(0),
	WithHttpClientTimeout(60 * time.Second),
}

func NewHtmlRenderer(options ...HtmlRendererOption) *HtmlRenderer {
	p := &HtmlRenderer{}

	for _, opt := range append(defaultOptions, options...) {
		p = opt(p)
	}
	return p
}

// HtmlRenderer is a service that communicates to a scalameta-js render
// backend over HTTP.
type HtmlRenderer struct {
	rnpb.UnimplementedRendererServer

	logger zerolog.Logger

	process    *memexec.Exec
	processDir string
	cmd        *exec.Cmd

	httpClient *http.Client
	httpUrl    string

	httpClientTimout time.Duration
	httpPort         int
}

func (s *HtmlRenderer) Stop() {
	if s.httpClient != nil {
		s.httpClient.CloseIdleConnections()
		s.httpClient = nil
	}
	if s.cmd != nil {
		s.cmd.Process.Kill()
		s.cmd = nil
	}
	if s.process != nil {
		s.process.Close()
		s.process = nil
	}
	if s.processDir != "" {
		os.RemoveAll(s.processDir)
		s.processDir = ""
	}
}

func (s *HtmlRenderer) Start() error {
	t1 := time.Now()

	//
	// Setup temp process directory and write js files
	//
	processDir, err := fsutil.NewTmpDir("")
	if err != nil {
		return fmt.Errorf("creating tmp process dir: %w", err)
	}

	scriptPath := filepath.Join(processDir, "renderer.mjs")
	renderPath := filepath.Join(processDir, "node_modules", "scalameta-renders", "index.js")

	if err := os.MkdirAll(filepath.Dir(renderPath), os.ModePerm); err != nil {
		return fmt.Errorf("mkdir process tmpdir: %w", err)
	}
	if err := os.WriteFile(scriptPath, []byte(rendererMjs), os.ModePerm); err != nil {
		return fmt.Errorf("writing %s: %w", rendererMjs, err)
	}
	if err := os.WriteFile(renderPath, []byte(indexJs), os.ModePerm); err != nil {
		return fmt.Errorf("writing %s: %w", indexJs, err)
	}

	// if debugrender {
	// 	ListFiles(".")
	// }

	//
	// ensure we have a port
	//
	if s.httpPort == 0 {
		port, err := getFreePort()
		if err != nil {
			return status.Errorf(codes.FailedPrecondition, "getting http port: %v", err)
		}
		s.httpPort = port
	}
	s.httpUrl = fmt.Sprintf("http://127.0.0.1:%d", s.httpPort)
	if debugRender {
		log.Println("httpUrl:", s.httpUrl)
	}

	s.logger.Debug().Msgf("Starting render: %s", s.httpUrl)

	//
	// Setup the node process
	//
	exe, err := memexec.New(nodeExe)
	if err != nil {
		return err
	}
	s.process = exe

	//
	// Start the node process
	//
	cmd := exe.Command("renderer.mjs")
	cmd.Dir = processDir
	cmd.Env = []string{
		"NODE_PATH=" + processDir,
		fmt.Sprintf("PORT=%d", s.httpPort),
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	s.cmd = cmd

	if debugRender {
		log.Println("cmd:", s.cmd)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting process %s: %w", indexJs, err)
	}
	go func() {
		// does it make sense to wait for the process?  We kill it forcefully
		// at the end anyway...
		if err := cmd.Wait(); err != nil {
			if err.Error() != "signal: killed" {
				log.Printf("command wait err: %v", err)
			}
		}
	}()

	if debugRender {
		log.Println("render connection created!")
	}

	host := "localhost"
	port := s.httpPort
	timeout := 10 * time.Second
	if !netutil.WaitForConnectionAvailable(host, port, timeout, debugRender) {
		return fmt.Errorf("timeout waiting to connect to html render server %s:%d within %s", host, port, timeout)
	}

	if debugRender {
		log.Println("render connection available!")
	}

	s.logger.Debug().Msgf("Started render: %s", s.httpUrl)

	//
	// Setup the http client
	//
	s.httpClient = &http.Client{
		Timeout: s.httpClientTimout,
		Transport: &http.Transport{
			Dial: (&net.Dialer{
				Timeout: 5 * time.Second,
			}).Dial,
			TLSHandshakeTimeout: 5 * time.Second,
		},
	}

	t2 := time.Since(t1).Round(1 * time.Millisecond)
	if debugRender {
		log.Printf("render started (%v)", t2)
	}

	return nil
}

func (s *HtmlRenderer) Render(ctx context.Context, in *rnpb.RenderRequest) (*rnpb.RenderResponse, error) {
	s.logger.Debug().Msgf("new render request: %+v", in)

	req, err := newHttpRenderRequest(s.httpUrl, in)
	if err != nil {
		return nil, err
	}
	req = req.WithContext(ctx)

	w, err := s.httpClient.Do(req)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "response error: %v", err)
	}

	if debugRender {
		respDump, err := httputil.DumpResponse(w, true)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("HTTP_RESPONSE:\n%s", string(respDump))
	}

	contentType := w.Header.Get("Content-Type")
	if contentType != contentTypeJSON {
		return nil, status.Errorf(codes.Internal, "response content-type error, want %q, got: %q", contentTypeJSON, contentType)
	}

	data, err := io.ReadAll(w.Body)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "response data error: %v", err)
	}

	if debugRender {
		log.Printf("response body: %s", string(data))
	}

	var response rnpb.RenderResponse
	if err := protojson.Unmarshal(data, &response); err != nil {
		return nil, status.Errorf(codes.Internal, "response body error: %v\n%s", err, string(data))
	}

	return &response, nil
}

// getFreePort asks the kernel for a free open port that is ready to use.
func getFreePort() (int, error) {
	addr, err := net.ResolveTCPAddr("tcp", "localhost:0")
	if err != nil {
		return 0, err
	}

	l, err := net.ListenTCP("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func newHttpRenderRequest(url string, in *rnpb.RenderRequest) (*http.Request, error) {
	if url == "" {
		return nil, status.Error(codes.InvalidArgument, "request URL is required")
	}
	if in == nil {
		return nil, status.Errorf(codes.InvalidArgument, "renderRequest is required")
	}

	json, err := protojson.Marshal(in)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "marshaling request: %v", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(json))
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "creating request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}
