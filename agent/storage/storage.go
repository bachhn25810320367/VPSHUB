package storage

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type FileItem struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
	IsDir   bool      `json:"is_dir"`
	Snippet string    `json:"snippet,omitempty"`
}

type TrashItem struct {
	ID           string    `json:"id"`
	OriginalName string    `json:"original_name"`
	Size         int64     `json:"size"`
	DeletedAt    time.Time `json:"deleted_at"`
	IsDir        bool      `json:"is_dir"`
}

var tagRegex = regexp.MustCompile(`<[^>]+>`)

func extractSnippet(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".docx" {
		r, err := zip.OpenReader(path)
		if err != nil {
			return ""
		}
		defer r.Close()
		for _, f := range r.File {
			if f.Name == "word/document.xml" {
				rc, err := f.Open()
				if err != nil {
					return ""
				}
				defer rc.Close()
				buf := make([]byte, 4096)
				n, _ := io.ReadFull(rc, buf)
				if n == 0 {
					return ""
				}
				txt := tagRegex.ReplaceAllString(string(buf[:n]), " ")
				fields := strings.Fields(txt)
				res := strings.Join(fields, " ")
				if len(res) > 300 {
					res = res[:300] + "..."
				}
				return res
			}
		}
	} else if ext == ".txt" || ext == ".md" || ext == ".json" || ext == ".sh" || ext == ".py" || ext == ".js" || ext == ".html" {
		f, err := os.Open(path)
		if err != nil {
			return ""
		}
		defer f.Close()
		buf := make([]byte, 300)
		n, _ := f.Read(buf)
		if n > 0 {
			res := strings.TrimSpace(string(buf[:n]))
			if len(res) > 300 {
				res = res[:300] + "..."
			}
			return res
		}
	}
	return ""
}

type StorageManager struct {
	dataDir   string
	uploadDir string
	tempDir   string
	trashDir  string
	lock      sync.Mutex
}

func NewStorageManager(dataDir string) (*StorageManager, error) {
	uploadDir := filepath.Join(dataDir, "uploads")
	tempDir := filepath.Join(dataDir, "temp")
	trashDir := filepath.Join(dataDir, ".trash")

	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		return nil, err
	}

	return &StorageManager{
		dataDir:   dataDir,
		uploadDir: uploadDir,
		tempDir:   tempDir,
		trashDir:  trashDir,
	}, nil
}

func (sm *StorageManager) resolvePath(subPath string) (string, error) {
	clean := filepath.Clean(strings.TrimSpace(subPath))
	if clean == "." || clean == "/" || clean == "\\" || clean == "" {
		return sm.uploadDir, nil
	}
	clean = strings.TrimPrefix(clean, "/")
	clean = strings.TrimPrefix(clean, "\\")
	full := filepath.Join(sm.uploadDir, clean)
	rel, err := filepath.Rel(sm.uploadDir, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("directory traversal forbidden")
	}
	return full, nil
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

	_, copyErr := io.Copy(chunkFile, r.Body)
	chunkFile.Close()
	if copyErr != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to write chunk: %v"}`, copyErr), http.StatusInternalServerError)
		return
	}

	// Check if all chunks have arrived
	sm.lock.Lock()
	defer sm.lock.Unlock()

	entries, _ := os.ReadDir(sessionTempDir)
	if len(entries) == totalChunks {
		targetDir := sm.uploadDir
		if relDir := r.URL.Query().Get("dir"); relDir != "" {
			if p, err := sm.resolvePath(relDir); err == nil {
				targetDir = p
			}
		}
		os.MkdirAll(targetDir, 0755)
		finalFilePath := filepath.Join(targetDir, fileName)
		finalFile, err := os.OpenFile(finalFilePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"Failed to assemble file: %v"}`, err), http.StatusInternalServerError)
			return
		}

		for i := 0; i < totalChunks; i++ {
			cPartPath := filepath.Join(sessionTempDir, fmt.Sprintf("chunk_%05d", i))
			partFile, openErr := os.Open(cPartPath)
			if openErr != nil {
				finalFile.Close()
				http.Error(w, fmt.Sprintf(`{"error":"Missing chunk %d during assembly"}`, i), http.StatusInternalServerError)
				return
			}
			io.Copy(finalFile, partFile)
			partFile.Close()
		}
		finalFile.Close()
		os.RemoveAll(sessionTempDir)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "completed",
			"file_name": fileName,
			"upload_id": uploadID,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "chunk_received",
		"chunk_index": chunkIndex,
		"upload_id":   uploadID,
	})
}

// HandleListFiles returns JSON list of stored files and subfolders
func (sm *StorageManager) HandleListFiles(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	targetDir, err := sm.resolvePath(relPath)
	if err != nil {
		http.Error(w, `{"error":"Invalid directory path"}`, http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(targetDir)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to read directory: %v"}`, err), http.StatusInternalServerError)
		return
	}

	files := make([]FileItem, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		itemRel := entry.Name()
		if relPath != "" && relPath != "." {
			itemRel = filepath.ToSlash(filepath.Join(relPath, entry.Name()))
		}
		if entry.IsDir() {
			files = append(files, FileItem{
				Name:    entry.Name(),
				Path:    itemRel,
				Size:    0,
				ModTime: info.ModTime(),
				IsDir:   true,
			})
		} else {
			snippet := extractSnippet(filepath.Join(targetDir, entry.Name()))
			files = append(files, FileItem{
				Name:    entry.Name(),
				Path:    itemRel,
				Size:    info.Size(),
				ModTime: info.ModTime(),
				IsDir:   false,
				Snippet: snippet,
			})
		}
	}

	parentPath := ""
	if relPath != "" && relPath != "." {
		parent := filepath.Dir(relPath)
		if parent != "." && parent != "/" {
			parentPath = filepath.ToSlash(parent)
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"files":        files,
		"current_path": relPath,
		"parent_path":  parentPath,
		"total":        len(files),
	})
}

// HandleCreateFolder creates a new folder
func (sm *StorageManager) HandleCreateFolder(w http.ResponseWriter, r *http.Request) {
	parentRel := r.URL.Query().Get("path")
	folderName := r.URL.Query().Get("name")
	if folderName == "" {
		var req struct {
			Path string `json:"path"`
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		parentRel = req.Path
		folderName = req.Name
	}
	folderName = filepath.Base(strings.TrimSpace(folderName))
	if folderName == "" || folderName == "." || folderName == "/" {
		http.Error(w, `{"error":"Invalid folder name"}`, http.StatusBadRequest)
		return
	}
	parentDir, err := sm.resolvePath(parentRel)
	if err != nil {
		http.Error(w, `{"error":"Invalid parent path"}`, http.StatusBadRequest)
		return
	}
	newFolderPath := filepath.Join(parentDir, folderName)
	if err := os.MkdirAll(newFolderPath, 0755); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to create folder: %v"}`, err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"name":    folderName,
	})
}

// HandleRename renames a file or folder
func (sm *StorageManager) HandleRename(w http.ResponseWriter, r *http.Request) {
	oldRel := r.URL.Query().Get("path")
	newName := r.URL.Query().Get("new_name")
	if oldRel == "" || newName == "" {
		var req struct {
			Path    string `json:"path"`
			NewName string `json:"new_name"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Path != "" {
			oldRel = req.Path
		}
		if req.NewName != "" {
			newName = req.NewName
		}
	}
	newName = filepath.Base(strings.TrimSpace(newName))
	if newName == "" || newName == "." || newName == "/" {
		http.Error(w, `{"error":"Invalid new name"}`, http.StatusBadRequest)
		return
	}

	srcPath, err := sm.resolvePath(oldRel)
	if err != nil {
		http.Error(w, `{"error":"Invalid source path"}`, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(srcPath); os.IsNotExist(err) {
		http.Error(w, `{"error":"File or directory does not exist"}`, http.StatusNotFound)
		return
	}

	destPath := filepath.Join(filepath.Dir(srcPath), newName)
	if err := os.Rename(srcPath, destPath); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to rename: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"new_name": newName,
	})
}

// HandleMove moves a file or folder into a destination folder
func (sm *StorageManager) HandleMove(w http.ResponseWriter, r *http.Request) {
	srcRel := r.URL.Query().Get("source")
	destRel := r.URL.Query().Get("target_dir")
	if srcRel == "" {
		var req struct {
			Source    string `json:"source"`
			TargetDir string `json:"target_dir"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Source != "" {
			srcRel = req.Source
		}
		if req.TargetDir != "" {
			destRel = req.TargetDir
		}
	}

	srcPath, err := sm.resolvePath(srcRel)
	if err != nil {
		http.Error(w, `{"error":"Invalid source path"}`, http.StatusBadRequest)
		return
	}
	targetDirPath, err := sm.resolvePath(destRel)
	if err != nil {
		http.Error(w, `{"error":"Invalid target directory"}`, http.StatusBadRequest)
		return
	}

	destPath := filepath.Join(targetDirPath, filepath.Base(srcPath))
	if err := os.Rename(srcPath, destPath); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to move item: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"moved":   filepath.Base(srcPath),
	})
}

// HandleDownloadFile streams the file with Range header support (no RAM buffering)
func (sm *StorageManager) HandleDownloadFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	if subPath == "" {
		subPath = r.URL.Query().Get("name")
	}
	if subPath == "" {
		http.Error(w, "File path or name is required", http.StatusBadRequest)
		return
	}

	targetPath, err := sm.resolvePath(subPath)
	if err != nil {
		http.Error(w, "Invalid file path", http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		// Fallback for flat names
		escaped := filepath.Join(sm.uploadDir, filepath.Base(subPath))
		if _, err2 := os.Stat(escaped); err2 == nil {
			targetPath = escaped
		} else {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
	}

	// http.ServeFile handles Range requests, mime types, and streaming automatically
	http.ServeFile(w, r, targetPath)
}

// HandleDeleteFile moves item to .trash (Soft Delete)
func (sm *StorageManager) HandleDeleteFile(w http.ResponseWriter, r *http.Request) {
	targetRel := r.URL.Query().Get("path")
	if targetRel == "" {
		targetRel = r.URL.Query().Get("name")
	}
	if targetRel == "" {
		http.Error(w, `{"error":"Path is required"}`, http.StatusBadRequest)
		return
	}

	targetPath, err := sm.resolvePath(targetRel)
	if err != nil {
		http.Error(w, `{"error":"Invalid path"}`, http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		targetPath = filepath.Join(sm.uploadDir, filepath.Base(targetRel))
		if _, err2 := os.Stat(targetPath); os.IsNotExist(err2) {
			http.Error(w, `{"error":"File not found"}`, http.StatusNotFound)
			return
		}
	}

	baseName := filepath.Base(targetPath)
	trashName := fmt.Sprintf("%d_%s", time.Now().Unix(), baseName)
	trashDest := filepath.Join(sm.trashDir, trashName)

	if err := os.Rename(targetPath, trashDest); err != nil {
		if err2 := os.RemoveAll(targetPath); err2 != nil {
			http.Error(w, fmt.Sprintf(`{"error":"Failed to delete: %v"}`, err2), http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "moved_to_trash",
		"file":    baseName,
		"success": true,
	})
}

// HandleListTrash returns items currently in .trash
func (sm *StorageManager) HandleListTrash(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(sm.trashDir)
	if err != nil {
		http.Error(w, `{"error":"Failed to read trash"}`, http.StatusInternalServerError)
		return
	}

	items := make([]TrashItem, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		orig := entry.Name()
		parts := strings.SplitN(entry.Name(), "_", 2)
		if len(parts) == 2 && len(parts[0]) >= 10 {
			orig = parts[1]
		}
		items = append(items, TrashItem{
			ID:           entry.Name(),
			OriginalName: orig,
			Size:         info.Size(),
			DeletedAt:    info.ModTime(),
			IsDir:        entry.IsDir(),
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"items": items,
		"total": len(items),
	})
}

// HandleRestoreTrash restores an item from .trash back to uploads
func (sm *StorageManager) HandleRestoreTrash(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":"Trash ID is required"}`, http.StatusBadRequest)
		return
	}
	id = filepath.Base(id)
	srcPath := filepath.Join(sm.trashDir, id)
	if _, err := os.Stat(srcPath); os.IsNotExist(err) {
		http.Error(w, `{"error":"Item not found in trash"}`, http.StatusNotFound)
		return
	}

	orig := id
	parts := strings.SplitN(id, "_", 2)
	if len(parts) == 2 && len(parts[0]) >= 10 {
		orig = parts[1]
	}

	destPath := filepath.Join(sm.uploadDir, orig)
	if _, err := os.Stat(destPath); err == nil {
		destPath = filepath.Join(sm.uploadDir, fmt.Sprintf("restored_%d_%s", time.Now().Unix(), orig))
	}

	if err := os.Rename(srcPath, destPath); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to restore: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"restored": orig,
	})
}

// HandleEmptyTrash purges all items inside .trash
func (sm *StorageManager) HandleEmptyTrash(w http.ResponseWriter, r *http.Request) {
	os.RemoveAll(sm.trashDir)
	os.MkdirAll(sm.trashDir, 0755)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Trash emptied permanently",
	})
}

// HandlePermanentDelete permanently deletes 1 item in trash
func (sm *StorageManager) HandlePermanentDelete(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":"Trash ID is required"}`, http.StatusBadRequest)
		return
	}
	id = filepath.Base(id)
	target := filepath.Join(sm.trashDir, id)
	if err := os.RemoveAll(target); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to delete permanently: %v"}`, err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"deleted": id,
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
	subPath := r.URL.Query().Get("path")
	if subPath == "" {
		subPath = r.URL.Query().Get("name")
	}
	if subPath == "" {
		http.Error(w, `{"error":"Missing file name"}`, http.StatusBadRequest)
		return
	}
	targetPath, err := sm.resolvePath(subPath)
	if err != nil {
		http.Error(w, `{"error":"Invalid file path"}`, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		escaped := filepath.Join(sm.uploadDir, filepath.Base(subPath))
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
		"archive": filepath.Base(targetPath),
		"entries": entries,
		"total":   len(entries),
	})
}

// HandleRemoteDownload downloads a file from URL directly to uploadDir
func (sm *StorageManager) HandleRemoteDownload(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, `{"error":"URL is required"}`, http.StatusBadRequest)
		return
	}

	parsed, err := url.Parse(targetURL)
	if err != nil {
		http.Error(w, `{"error":"Invalid URL"}`, http.StatusBadRequest)
		return
	}

	fileName := filepath.Base(parsed.Path)
	if fileName == "" || fileName == "/" || fileName == "." {
		fileName = fmt.Sprintf("download_%d.bin", time.Now().Unix())
	}

	targetDir := sm.uploadDir
	if relDir := r.URL.Query().Get("dir"); relDir != "" {
		if p, err := sm.resolvePath(relDir); err == nil {
			targetDir = p
		}
	}

	outPath := filepath.Join(targetDir, fileName)
	resp, err := http.Get(targetURL)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to fetch URL: %v"}`, err), http.StatusBadRequest)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf(`{"error":"Remote server returned status %d"}`, resp.StatusCode), http.StatusBadRequest)
		return
	}

	out, err := os.Create(outPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to create file: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer out.Close()

	written, err := io.Copy(out, resp.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"Failed to save file: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"file":    fileName,
		"size":    written,
	})
}
