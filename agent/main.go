package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"vps-agent/storage"
	"vps-agent/sysinfo"
)

func getEnvOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func main() {
	port := flag.String("port", getEnvOrDefault("AGENT_PORT", "8085"), "Port for agent HTTP server")
	vpsID := flag.String("vps-id", getEnvOrDefault("VPS_ID", "vps1"), "Unique identifier for this VPS")
	vpsName := flag.String("vps-name", getEnvOrDefault("VPS_NAME", "VPS-Tokyo"), "Friendly name for this VPS")
	hubURL := flag.String("hub-url", getEnvOrDefault("HUB_URL", "https://app.hoangngocbach.id.vn/api/telemetry"), "Azure Functions telemetry URL")
	secret := flag.String("secret", getEnvOrDefault("AGENT_SECRET", "secret-token-change-me"), "Shared secret token for authentication")
	intervalStr := flag.String("interval", getEnvOrDefault("TELEMETRY_INTERVAL", "30s"), "Interval between telemetry reports")
	dataDir := flag.String("data-dir", getEnvOrDefault("DATA_DIR", "./data"), "Directory for file storage")

	flag.Parse()

	interval, err := time.ParseDuration(*intervalStr)
	if err != nil {
		interval = 30 * time.Second
	}

	log.Printf("[VPS-Agent] Starting for %s (%s) on port %s", *vpsName, *vpsID, *port)
	log.Printf("[VPS-Agent] Telemetry hub: %s (reporting every %v)", *hubURL, interval)
	log.Printf("[VPS-Agent] Storage directory: %s", *dataDir)

	storageMgr, err := storage.NewStorageManager(*dataDir)
	if err != nil {
		log.Fatalf("[VPS-Agent] Failed to initialize storage: %v", err)
	}

	// Start background telemetry pusher
	go startTelemetryReporter(*vpsID, *vpsName, *hubURL, *secret, interval)

	// Setup HTTP router
	mux := http.NewServeMux()

	// Health check (public, for uptime monitoring)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "healthy",
			"vps_id":    *vpsID,
			"vps_name":  *vpsName,
			"timestamp": time.Now().Unix(),
		})
	})

	// Local metrics snapshot (protected)
	mux.HandleFunc("/api/metrics", func(w http.ResponseWriter, r *http.Request) {
		metrics, err := sysinfo.CollectMetrics(*vpsID, *vpsName)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(metrics)
	})

	// File Storage Endpoints
	mux.HandleFunc("/api/files/upload-chunk", storageMgr.HandleUploadChunk)
	mux.HandleFunc("/api/files/list", storageMgr.HandleListFiles)
	mux.HandleFunc("/api/files/download", storageMgr.HandleDownloadFile)
	mux.HandleFunc("/api/files/delete", storageMgr.HandleDeleteFile)
	mux.HandleFunc("/api/files/archive-inspect", storageMgr.HandleInspectArchive)

	// Combine CORS and Authentication middlewares
	handler := corsMiddleware(authMiddleware(*secret, mux))

	server := &http.Server{
		Addr:         ":" + *port,
		Handler:      handler,
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("[VPS-Agent] HTTP server listening on http://127.0.0.1:%s", *port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[VPS-Agent] Server failed: %v", err)
	}
}

// Background goroutine pushing metrics to Azure Functions
func startTelemetryReporter(vpsID, vpsName, hubURL, secret string, interval time.Duration) {
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Initial report after 2 seconds
	time.Sleep(2 * time.Second)
	sendReport(client, vpsID, vpsName, hubURL, secret)

	for range ticker.C {
		sendReport(client, vpsID, vpsName, hubURL, secret)
	}
}

func sendReport(client *http.Client, vpsID, vpsName, hubURL, secret string) {
	if hubURL == "" || strings.HasPrefix(hubURL, "http://localhost") || strings.Contains(hubURL, "example.com") {
		return // Skip if not configured with valid remote hub
	}

	metrics, err := sysinfo.CollectMetrics(vpsID, vpsName)
	if err != nil {
		log.Printf("[Telemetry] Error collecting metrics: %v", err)
		return
	}

	payload, err := json.Marshal(metrics)
	if err != nil {
		log.Printf("[Telemetry] Error marshaling metrics: %v", err)
		return
	}

	req, err := http.NewRequest("POST", hubURL, bytes.NewBuffer(payload))
	if err != nil {
		log.Printf("[Telemetry] Error creating request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-Secret", secret)

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[Telemetry] Failed to post to hub: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		log.Printf("[Telemetry] Hub returned non-200 status: %d", resp.StatusCode)
	}
}

// CORS Middleware with complete OPTIONS Preflight support
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Upload-Id, Chunk-Index, Total-Chunks, File-Name, X-Agent-Secret, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// Auth Middleware to protect private endpoints
func authMiddleware(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Health check is always public
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		// Download can accept token in query parameter for direct browser <a> links
		token := r.Header.Get("X-Agent-Secret")
		if token == "" {
			authHeader := r.Header.Get("Authorization")
			if strings.HasPrefix(authHeader, "Bearer ") {
				token = strings.TrimPrefix(authHeader, "Bearer ")
			}
		}
		if token == "" && r.URL.Path == "/api/files/download" {
			token = r.URL.Query().Get("token")
		}

		if secret != "" && token != secret {
			http.Error(w, `{"error":"Unauthorized: Invalid agent secret"}`, http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}
