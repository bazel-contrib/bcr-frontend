package main

import (
	"archive/tar"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	log.SetPrefix("releaseserver: ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	var (
		port     = flag.Int("port", 8080, "port to listen on (0 = pick a free port)")
		host     = flag.String("host", "localhost", "host to bind to")
		portFile = flag.String("port_file", "", "if set, write the chosen port to this file once listening")
	)

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: %s [options] <tarball>\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Serve a tarball as a Single Page Application with fallback to index.html.\n\n")
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExample:\n")
		fmt.Fprintf(os.Stderr, "  %s --port=8080 release.tar\n", os.Args[0])
	}

	flag.Parse()

	args := flag.Args()
	if len(args) != 1 {
		flag.Usage()
		os.Exit(1)
	}

	tarballPath := args[0]

	// Load the tarball into memory
	files, err := loadTarball(tarballPath)
	if err != nil {
		log.Fatalf("Failed to load tarball: %v", err)
	}

	// Calculate total size
	var totalSize int
	for _, content := range files {
		totalSize += len(content)
	}

	log.Printf("Loaded %d files from %s (total: %s)", len(files), tarballPath, formatBytes(totalSize))
	for path, content := range files {
		// if strings.HasSuffix(path, "documentationinfo.pb.gz") {
		// 	continue
		// }
		// if strings.HasSuffix(path, "packageinfo.pb.gz") {
		// 	continue
		// }
		log.Printf("  - %s (%s)", path, formatBytes(len(content)))
	}

	// Create and start server
	server := NewSPAServer(files)

	listener, err := listenSafePort(*host, *port)
	if err != nil {
		log.Fatalf("Failed to listen on %s:%d: %v", *host, *port, err)
	}

	chosenPort := listener.Addr().(*net.TCPAddr).Port
	log.Printf("Starting server on http://%s:%d", *host, chosenPort)
	log.Printf("Press Ctrl+C to stop")

	if *portFile != "" {
		if err := os.WriteFile(*portFile, []byte(fmt.Sprintf("%d\n", chosenPort)), 0644); err != nil {
			log.Fatalf("Failed to write port file %s: %v", *portFile, err)
		}
	}

	if err := http.Serve(listener, server); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

// SPAServer serves files from memory with SPA fallback behavior
type SPAServer struct {
	files     map[string][]byte
	indexHTML []byte
	hasIndex  bool
}

// NewSPAServer creates a new SPA server
func NewSPAServer(files map[string][]byte) *SPAServer {
	indexHTML, hasIndex := files["index.html"]
	return &SPAServer{
		files:     files,
		indexHTML: indexHTML,
		hasIndex:  hasIndex,
	}
}

// ServeHTTP implements http.Handler
func (s *SPAServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Log the request
	log.Printf("%s %s", r.Method, r.URL.Path)

	// Only handle GET requests
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Clean the path
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}

	// Try to serve the exact file
	if content, ok := s.files[path]; ok {
		s.serveFile(w, r, path, content)
		return
	}

	// Directory-style: try <path>/index.html (so /modules/rules_buf
	// resolves to modules/rules_buf/index.html when present).
	if path != "" {
		dirIndex := strings.TrimSuffix(path, "/") + "/index.html"
		if content, ok := s.files[dirIndex]; ok {
			log.Printf("  -> %s", dirIndex)
			s.serveFile(w, r, dirIndex, content)
			return
		}
	}

	// SPA fallback: serve index.html for unknown paths
	if s.hasIndex {
		log.Printf("  -> fallback to index.html")
		s.serveFile(w, r, "index.html", s.indexHTML)
		return
	}

	// No index.html available
	http.NotFound(w, r)
}

// serveFile serves a file with appropriate headers
func (s *SPAServer) serveFile(w http.ResponseWriter, r *http.Request, path string, content []byte) {
	// Set Content-Type based on file extension
	ext := filepath.Ext(path)
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)

	// Set caching headers
	// For HTML files and raw protobufs that aren't hashed, don't cache (always fresh)
	// For assets, cache for a long time (they should be content-hashed)
	if strings.HasSuffix(path, ".html") || strings.HasSuffix(path, ".pb") {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	} else {
		// Assets are content-hashed, so cache aggressively
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	// Handle HEAD requests
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
		w.WriteHeader(http.StatusOK)
		return
	}

	// Write the content
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(content); err != nil {
		log.Printf("Error writing response: %v", err)
	}
}

// formatBytes formats byte count as human-readable size
func formatBytes(bytes int) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// loadTarball loads a tarball into memory
func loadTarball(path string) (map[string][]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open tarball: %w", err)
	}
	defer file.Close()

	files := make(map[string][]byte)
	tr := tar.NewReader(file)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to read tar header: %w", err)
		}

		// Skip directories
		if header.Typeflag == tar.TypeDir {
			continue
		}

		// Read file content
		content, err := io.ReadAll(tr)
		if err != nil {
			return nil, fmt.Errorf("failed to read file %s from tar: %w", header.Name, err)
		}

		// Store with cleaned path (remove leading ./)
		cleanPath := strings.TrimPrefix(header.Name, "./")
		files[cleanPath] = content
	}

	return files, nil
}

// chromeUnsafePorts mirrors Chrome's restricted-port list (net/base/port_util.cc).
// Chrome refuses to navigate to URLs on these ports with ERR_UNSAFE_PORT, which
// breaks chromedp-driven prerendering when the kernel happens to hand the
// server one of them via port=0. listenSafePort retries past them.
var chromeUnsafePorts = map[int]bool{
	1: true, 7: true, 9: true, 11: true, 13: true, 15: true, 17: true,
	19: true, 20: true, 21: true, 22: true, 23: true, 25: true, 37: true,
	42: true, 43: true, 53: true, 69: true, 77: true, 79: true, 87: true,
	95: true, 101: true, 102: true, 103: true, 104: true, 109: true,
	110: true, 111: true, 113: true, 115: true, 117: true, 119: true,
	123: true, 135: true, 137: true, 139: true, 143: true, 161: true,
	179: true, 389: true, 427: true, 465: true, 512: true, 513: true,
	514: true, 515: true, 526: true, 530: true, 531: true, 532: true,
	540: true, 548: true, 554: true, 556: true, 563: true, 587: true,
	601: true, 636: true, 989: true, 990: true, 993: true, 995: true,
	1719: true, 1720: true, 1723: true, 2049: true, 3659: true, 4045: true,
	4190: true, 5060: true, 5061: true, 6000: true, 6566: true, 6665: true,
	6666: true, 6667: true, 6668: true, 6669: true, 6679: true, 6697: true,
	10080: true,
}

// listenSafePort binds a TCP listener at host:port. When port == 0 and the
// kernel assigns a port Chrome considers unsafe, the listener is closed and
// we retry up to a small bound. Explicit ports are returned as-is.
func listenSafePort(host string, port int) (net.Listener, error) {
	if port != 0 {
		return net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	}
	const maxAttempts = 32
	for i := 0; i < maxAttempts; i++ {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:0", host))
		if err != nil {
			return nil, err
		}
		assigned := l.Addr().(*net.TCPAddr).Port
		if !chromeUnsafePorts[assigned] {
			return l, nil
		}
		log.Printf("Skipping Chrome-unsafe port %d, retrying", assigned)
		l.Close()
	}
	return nil, fmt.Errorf("could not get a Chrome-safe ephemeral port after %d attempts", maxAttempts)
}
