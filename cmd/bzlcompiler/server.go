package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type serverResources struct {
	cmd     *exec.Cmd
	port    int
	logFile *os.File
	conn    *grpc.ClientConn
}

// initializeServer starts the Java server process, creates a gRPC client, and waits for the server to be ready
func initializeServer(javaInterpreter, serverJar string, port int, logFilePrefix string, logger *log.Logger) (*serverResources, func(), error) {
	var serverResources serverResources

	// only host the server ourselves if port has been unassigned.  Otherwise,
	// assume it is running externally (e.g., in development)
	if port == 0 {
		port = mustGetFreePort(logger)
		// Start the server process
		cmd, logFile, err := startServerProcess(javaInterpreter, serverJar, port, logFilePrefix, logger)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to start server process: %w", err)
		}
		serverResources.cmd = cmd
		serverResources.logFile = logFile
	}

	// Create gRPC client
	conn, err := grpc.NewClient(
		fmt.Sprintf("localhost:%d", port),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)

	cleanup := func() {
		// Cleanup: kill server process
		if serverResources.cmd != nil && serverResources.cmd.Process != nil {
			logger.Println("Shutting down server process...")
			if err := serverResources.cmd.Process.Kill(); err != nil {
				logger.Printf("Error killing server process: %v", err)
			}
		}
		if serverResources.logFile != nil {
			serverResources.logFile.Close()
		}
		if conn != nil {
			conn.Close()
		}
	}

	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("failed to create gRPC client: %w", err)
	}

	client := slpb.NewStarlarkClient(conn)
	serverResources.conn = conn

	// Wait for server to be ready
	if err := waitForServer(client, 30*time.Second, logger); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("server failed to start: %w", err)
	}

	return &serverResources, cleanup, nil
}

func startServerProcess(javaInterpreter, serverJar string, port int, logFilePrefix string, logger *log.Logger) (*exec.Cmd, *os.File, error) {
	// Create log file for server output
	serverLogPath := logFilePrefix + ".server.log"
	if serverLogPath == "" || serverLogPath == ".server.log" {
		serverLogPath = "bzlcompiler.server.log"
	}
	serverLogFile, err := os.OpenFile(serverLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create server log file: %v", err)
	}

	// Build command: java -jar server.jar --log_level=FINE --listen_port=<port>
	cmd := exec.Command(
		javaInterpreter,
		"-jar",
		serverJar,
		// "--log_level=FINE",
		fmt.Sprintf("--listen_port=%d", port),
	)

	// Redirect stdout and stderr to log file
	cmd.Stdout = serverLogFile
	cmd.Stderr = serverLogFile

	logger.Printf("Starting server: %s -jar %s --log_level=FINE --listen_port=%d", javaInterpreter, serverJar, port)
	logger.Printf("Server logs: %s", serverLogPath)

	if err := cmd.Start(); err != nil {
		serverLogFile.Close()
		return nil, nil, fmt.Errorf("failed to start server: %v", err)
	}

	// Monitor server process in background
	go func() {
		if err := cmd.Wait(); err != nil {
			logger.Printf("Server process exited with error: %v", err)
			logger.Printf("Check server logs at: %s", serverLogPath)
		} else {
			logger.Printf("Server process exited cleanly")
		}
	}()

	return cmd, serverLogFile, nil
}

func waitForServer(client slpb.StarlarkClient, timeout time.Duration, logger *log.Logger) error {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	logger.Println("Waiting for server to be ready...")
	attempts := 0

	for time.Now().Before(deadline) {
		select {
		case <-ticker.C:
			attempts++
			// Try to establish connection with simple dial
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, err := client.Ping(ctx, &slpb.PingRequest{})
			cancel()

			// If we get any response (even an error), server is up
			if err == nil {
				logger.Printf("Server ready after %d attempts", attempts)
				return nil
			}

			// Check if it's a connection error (server not ready)
			errStr := err.Error()
			isConnError := strings.Contains(errStr, "connection refused") ||
				strings.Contains(errStr, "connection reset") ||
				strings.Contains(errStr, "connect: no route to host") ||
				strings.Contains(errStr, "dial tcp") && strings.Contains(errStr, "connect:")

			if !isConnError {
				// Server responded with an error, but it's responding
				logger.Printf("Server responding after %d attempts (with error, but that's ok)", attempts)
				return nil
			}

			if attempts%10 == 0 {
				logger.Printf("Still waiting for server... (attempt %d)", attempts)
			}
		}
	}

	return fmt.Errorf("server did not start within %v after %d attempts", timeout, attempts)
}

func mustGetFreePort(logger *log.Logger) int {
	port, err := getFreePort()
	if err != nil {
		log.Panicf("Unable to determine free port: %v", err)
	}
	return port
}

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
