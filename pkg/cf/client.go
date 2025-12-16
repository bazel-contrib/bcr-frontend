package cf

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	apiBaseURL = "https://api.cloudflare.com/client/v4"
)

// Client represents a Cloudflare API client
type Client struct {
	apiToken   string
	accountID  string
	httpClient *http.Client
	logger     Logger
}

// Logger is an interface for logging
type Logger interface {
	Printf(format string, v ...interface{})
}

type noopLogger struct{}

func (noopLogger) Printf(format string, v ...interface{}) {}

// NewClient creates a new Cloudflare API client
func NewClient(apiToken, accountID string) *Client {
	return &Client{
		apiToken:  apiToken,
		accountID: accountID,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		logger: noopLogger{},
	}
}

// SetLogger sets a custom logger for the client
func (c *Client) SetLogger(logger Logger) {
	c.logger = logger
}

// logf logs a message if a logger is configured
func (c *Client) logf(format string, v ...interface{}) {
	if c.logger != nil {
		c.logger.Printf(format, v...)
	}
}

// APIResponse represents a standard Cloudflare API response
type APIResponse struct {
	Success  bool            `json:"success"`
	Errors   []APIError      `json:"errors"`
	Messages []string        `json:"messages"`
	Result   json.RawMessage `json:"result"`
}

// APIError represents a Cloudflare API error
type APIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e APIError) Error() string {
	return fmt.Sprintf("cloudflare API error %d: %s", e.Code, e.Message)
}

// doRequest performs an HTTP request with proper authentication
func (c *Client) doRequest(method, path string, body interface{}) (*APIResponse, error) {
	var reqBody io.Reader
	if body != nil {
		jsonData, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(jsonData)
	}

	url := apiBaseURL + path
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to perform request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !apiResp.Success {
		if len(apiResp.Errors) > 0 {
			return nil, apiResp.Errors[0]
		}
		return nil, fmt.Errorf("API request failed without error details")
	}

	return &apiResp, nil
}