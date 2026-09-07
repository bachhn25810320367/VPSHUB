package storage

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type FileItem struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

type StorageManager struct {
	dataDir   string
	uploadDir string
	tempDir   string
	lock      sync.Mutex
}

func NewStorageManager(dataDir string) (*StorageManager, error) {
	uploadDir := filepath.Join(dataDir, "uploads")
	tempDir := filepath.Join(dataDir, "temp")

	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, err
	}

	return &StorageManager{
		dataDir:   dataDir,
		uploadDir: uploadDir,
		tempDir:   tempDir,
	}, nil
}

// HandleUploadChunk receives 1 chunk (up to 20-50MB) and saves it to disk with minimal RAM
func (sm *StorageManager) HandleUploadChunk(w http.ResponseWriter, r *http.Request) {
	uploadID := r.Header.Get("Upload-Id")
	chunkIndexStr := r.Header.Get("Chunk-Index")
	totalChunksStr := r.Header.Get("Total-Chunks")
	fileName := r.URL.Query().Get("file_name")
	if fileName == "" {
		fileName = r.Header.Get("File-Name")
	}

	if uploadID == "" || chunkIndexStr == "" || totalChunksStr == "" || fileName == "" {
		http.Error(w, `{"error":"Missing required upload headers"}`, http.StatusBadRequest)
		return
	}

	if unescaped, err := url.QueryUnescape(fileName); err == nil && unescaped != "" {
		fileName = unescaped
	}

	// Sanitize fileName to prevent directory traversal
	fileName = filepath.Base(fileName)
	if fileName == "." || fileName == "/" || fileName == "\\" {
		http.Error(w, `{"error":"Invalid file name"}`, http.StatusBadRequest)
		return
	}

	chunkIndex, err1 := strconv.Atoi(chunkIndexStr)
	totalChunks, err2 := strconv.Atoi(totalChunksStr)
	if err1 != nil || err2 != nil || chunkIndex < 0 || totalChunks <= 0 || chunkIndex >= totalChunks {
		http.Error(w, `{"error":"Invalid chunk index or total chunks"}`, http.StatusBadRequest)
		return
	}

	sessionTempDir := filepath.Join(sm.tempDir, uploadID)
	if err := os.MkdirAll(sessionTempDir, 0755); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to create temp dir: %v"}`, err), http.StatusInternalServerError)
		return
	}

	chunkPath := filepath.Join(sessionTempDir, fmt.Sprintf("chunk_%05d", chunkIndex))
	chunkFile, err := os.OpenFile(chunkPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to create chunk file: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer chunkFile.Close()

	// Stream HTTP request body directly to disk using a small 64KB buffer (zero RAM waste)
	buf := make([]byte, 64*1024)
	_, err = io.CopyBuffer(chunkFile, r.Body, buf)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to write chunk: %v"}`, err), http.StatusInternalServerError)
		return
	}

	// Check if all chunks have arrived
	sm.lock.Lock()
	defer sm.lock.Unlock()

	allPresent := true
	for i := 0; i < totalChunks; i++ {
		p := filepath.Join(sessionTempDir, fmt.Sprintf("chunk_%05d", i))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			allPresent = false
			break
		}
	}

	if !allPresent {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":        "chunk_saved",
			"chunk_index":   chunkIndex,
			"total_chunks":  totalChunks,
			"upload_id":     uploadID,
		})
		return
	}

	// Assemble chunks into final file
	targetPath := filepath.Join(sm.uploadDir, fileName)
	finalFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to create destination file: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer finalFile.Close()

	for i := 0; i < totalChunks; i++ {
		p := filepath.Join(sessionTempDir, fmt.Sprintf("chunk_%05d", i))
		cFile, err := os.Open(p)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"Failed to read chunk %d: %v"}`, i, err), http.StatusInternalServerError)
			return
		}
		_, err = io.CopyBuffer(finalFile, cFile, buf)
		cFile.Close()
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"Failed to merge chunk %d: %v"}`, i, err), http.StatusInternalServerError)
			return
		}
	}

	// Clean up temp chunks
	_ = os.RemoveAll(sessionTempDir)

	stat, _ := finalFile.Stat()
	finalSize := int64(0)
	if stat != nil {
		finalSize = stat.Size()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "completed",
		"file_name": fileName,
		"size":      finalSize,
		"upload_id": uploadID,
	})
}

// HandleListFiles returns JSON list of stored files
func (sm *StorageManager) HandleListFiles(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(sm.uploadDir)
	if err != nil {
		http.Error(w, `{"error":"Failed to read upload directory"}`, http.StatusInternalServerError)
		return
	}

	files := make([]FileItem, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, FileItem{
			Name:    entry.Name(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"files": files,
		"total": len(files),
	})
}

// HandleDownloadFile streams the file with Range header support (no RAM buffering)
func (sm *StorageManager) HandleDownloadFile(w http.ResponseWriter, r *http.Request) {
	fileName := r.URL.Query().Get("name")
	if fileName == "" {
		http.Error(w, "File name query parameter is required", http.StatusBadRequest)
		return
	}

	fileName = filepath.Base(fileName)
	targetPath := filepath.Join(sm.uploadDir, fileName)

	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		// Fallback: try raw escaped name if uploaded by older client
		escapedPath := filepath.Join(sm.uploadDir, url.QueryEscape(fileName))
		if _, err2 := os.Stat(escapedPath); err2 == nil {
			targetPath = escapedPath
		} else {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
	}

	// http.ServeFile handles Range requests, mime types, and streaming automatically
	http.ServeFile(w, r, targetPath)
}

// HandleDeleteFile removes a file
func (sm *StorageManager) HandleDeleteFile(w http.ResponseWriter, r *http.Request) {
	fileName := r.URL.Query().Get("name")
	if fileName == "" {
		http.Error(w, `{"error":"File name is required"}`, http.StatusBadRequest)
		return
	}

	fileName = filepath.Base(fileName)
	targetPath := filepath.Join(sm.uploadDir, fileName)

	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		escapedPath := filepath.Join(sm.uploadDir, url.QueryEscape(fileName))
		if _, err2 := os.Stat(escapedPath); err2 == nil {
			targetPath = escapedPath
		}
	}

	if err := os.Remove(targetPath); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to delete file: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "deleted",
		"file":    fileName,
		"success": true,
	})
}

// ArchiveEntry represents a file or directory inside an archive
type ArchiveEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Packed   int64  `json:"packed"`
	Modified string `json:"modified"`
	IsDir    bool   `json:"is_dir"`
}

// HandleInspectArchive runs 7z to inspect archive contents (rar, zip, 7z, tar, gz)
func (sm *StorageManager) HandleInspectArchive(w http.ResponseWriter, r *http.Request) {
	fileName := r.URL.Query().Get("name")
	if fileName == "" {
		http.Error(w, `{"error":"Missing file name"}`, http.StatusBadRequest)
		return
	}
	fileName = filepath.Base(fileName)
	targetPath := filepath.Join(sm.uploadDir, fileName)
	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		escaped := filepath.Join(sm.uploadDir, url.QueryEscape(fileName))
		if _, err2 := os.Stat(escaped); err2 == nil {
			targetPath = escaped
		} else {
			http.Error(w, `{"error":"Archive file not found"}`, http.StatusNotFound)
			return
		}
	}

	cmd := exec.Command("7z", "l", "-slt", targetPath)
	out, err := cmd.Output()
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to inspect archive: %v"}`, err), http.StatusInternalServerError)
		return
	}

	lines := strings.Split(string(out), "\n")
	var entries []ArchiveEntry
	var cur ArchiveEntry
	inListing := false

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "----------") {
			inListing = true
			continue
		}
		if !inListing {
			continue
		}

		if line == "" {
			if cur.Name != "" && cur.Name != targetPath {
				entries = append(entries, cur)
			}
			cur = ArchiveEntry{}
			continue
		}

		parts := strings.SplitN(line, " = ", 2)
		if len(parts) == 2 {
			k, v := parts[0], parts[1]
			switch k {
			case "Path":
				cur.Name = v
			case "Size":
				cur.Size, _ = strconv.ParseInt(v, 10, 64)
			case "Packed Size":
				cur.Packed, _ = strconv.ParseInt(v, 10, 64)
			case "Modified":
				cur.Modified = v
			case "Folder":
				cur.IsDir = (v == "+")
			}
		}
	}
	if cur.Name != "" && cur.Name != targetPath {
		entries = append(entries, cur)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"archive": fileName,
		"entries": entries,
		"total":   len(entries),
	})
}
