package netutil

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/schollz/progressbar/v3"
)

const connectionAvailableDuration = 250 * time.Millisecond

// WaitForConnectionAvailable pings a tcp connection every 250 milliseconds
// until it connects and returns true.  If it fails to connect by the timeout
// deadline, returns false.
func WaitForConnectionAvailable(host string, port int, timeout time.Duration, progress bool) bool {
	target := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	var wg sync.WaitGroup
	wg.Add(1)

	success := make(chan bool, 1)

	go func() {
		go func() {
			defer wg.Done()
			for {
				_, err := net.Dial("tcp", target)
				if err == nil {
					break
				}
				if progress {
					log.Println(err)
				}
				time.Sleep(connectionAvailableDuration)
			}
		}()
		wg.Wait()
		success <- true
	}()

	select {
	case <-success:
		return true
	case <-time.After(timeout):
		return false
	}
}

// URLStatus represents the HTTP status of a URL check
type URLStatus struct {
	Code    int    // HTTP status code (0 if request failed)
	Message string // HTTP status message (or error message if request failed)
}

// Exists returns true if the status code indicates success (2xx)
func (s URLStatus) Exists() bool {
	return s.Code >= 200 && s.Code < 300
}

// CheckURL checks if a URL is accessible by performing a HEAD request
// Returns URLStatus with the HTTP status code and message
func CheckURL(url string) URLStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return URLStatus{Code: 0, Message: err.Error()}
	}

	// Add a User-Agent to avoid being blocked by some servers
	req.Header.Set("User-Agent", "Bazel-Central-Registry-Gazelle/1.0")

	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Allow up to 10 redirects
			if len(via) >= 10 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		return URLStatus{Code: 0, Message: err.Error()}
	}
	defer resp.Body.Close()

	return URLStatus{Code: resp.StatusCode, Message: resp.Status}
}

// URLExists checks if a URL is accessible by performing a HEAD request
// Returns true if the resource exists (HTTP 200-299), false otherwise
func URLExists(url string) bool {
	status := CheckURL(url)
	return status.Exists()
}

// CheckURLsParallel checks a list of URLs in parallel using channels
// Returns a slice of URLStatus structs with HTTP status code and message
// The getURL function extracts the URL string from each item
// The onResult callback is called for each completed check (optional, can be nil)
// Uses a worker pool with up to 10 concurrent workers
// Displays progress with a visual progress bar
func CheckURLsParallel[T any](desc string, items []T, getURL func(T) string, onResult func(T, URLStatus)) []URLStatus {
	if len(items) == 0 {
		return nil
	}

	total := len(items)
	results := make([]URLStatus, total)
	var wg sync.WaitGroup
	var mu sync.Mutex

	bar := progressbar.NewOptions(total,
		progressbar.OptionSetDescription(desc),
		progressbar.OptionShowCount(),
		progressbar.OptionSetWidth(40),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "=",
			SaucerHead:    ">",
			SaucerPadding: " ",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)

	urlChan := make(chan struct {
		index int
		item  T
		url   string
	}, total)
	resultChan := make(chan struct {
		index  int
		item   T
		status URLStatus
	}, total)

	// Start worker goroutines
	numWorkers := min(10, total) // Limit concurrent HTTP requests

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range urlChan {
				status := CheckURL(job.url)
				resultChan <- struct {
					index  int
					item   T
					status URLStatus
				}{index: job.index, item: job.item, status: status}
			}
		}()
	}

	// Send URLs to check
	go func() {
		for i, item := range items {
			urlChan <- struct {
				index int
				item  T
				url   string
			}{index: i, item: item, url: getURL(item)}
		}
		close(urlChan)
	}()

	// Collect results with progress reporting
	go func() {
		wg.Wait()
		close(resultChan)
	}()

	for result := range resultChan {
		mu.Lock()
		results[result.index] = result.status
		mu.Unlock()

		if onResult != nil {
			onResult(result.item, result.status)
		}

		bar.Add(1)
	}

	return results
}
