package remotecache

import (
	"container/list"
	"encoding/hex"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type diskEntry struct {
	path string
	size int64
	pins int
}

type diskBudget struct {
	mu       sync.Mutex
	lock     *os.File
	limit    int64
	block    int64
	used     int64
	reserved int64
	entries  map[string]*list.Element
	lru      list.List
}

// NewBoundedFileCache opens a dedicated cache directory with a shared AC and CAS
// budget, across all instance names. Close releases exclusive use of the directory.
func NewBoundedFileCache(root string, maxBytes int64) (*fileCache, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("cache budget must be positive")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(root, ".cache-lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	budget := &diskBudget{lock: lock, limit: maxBytes, entries: make(map[string]*list.Element)}
	if err := budget.load(root); err != nil {
		lock.Close()
		return nil, err
	}
	return &fileCache{root: root, budget: budget}, nil
}

func (f *fileCache) Close() error {
	return f.budget.lock.Close()
}

func (b *diskBudget) load(root string) error {
	if err := syscall.Flock(int(b.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("lock bounded cache directory: %w", err)
	}
	var disk syscall.Statfs_t
	if err := syscall.Statfs(root, &disk); err != nil {
		return err
	}
	b.block = int64(disk.Bsize)
	if b.block <= 0 || b.limit < b.block {
		return fmt.Errorf("cache budget must hold at least one filesystem block")
	}
	type existing struct {
		entry *diskEntry
		time  time.Time
	}
	var files []existing
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		parts := strings.Split(path[len(root)+1:], string(filepath.Separator))
		switch len(parts) {
		case 1:
			if d.IsDir() && isHex(parts[0], 64) {
				return nil
			}
		case 2:
			if d.IsDir() && (parts[1] == "ac" || parts[1] == "cas") {
				return nil
			}
		case 3:
			if d.IsDir() && isHex(parts[2], 2) {
				return nil
			}
		case 4:
			if d.Type().IsRegular() {
				if strings.HasPrefix(d.Name(), ".upload-") {
					return os.Remove(path)
				}
				hash, sizeText, ok := strings.Cut(d.Name(), "-")
				size, parseErr := strconv.ParseInt(sizeText, 10, 64)
				if !ok || !isHex(hash, 64) || hash[:2] != parts[2] || parseErr != nil || size < 0 {
					return nil
				}
				info, err := d.Info()
				if err != nil {
					return err
				}
				files = append(files, existing{&diskEntry{path: path, size: b.cost(info.Size())}, info.ModTime()})
				return nil
			}
		}
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].time.Before(files[j].time) })
	for _, file := range files {
		b.add(file.entry)
	}
	return b.makeRoom(0)
}

func isHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// Round up file sizes to allocation blocks and charge empty files one block.
func (b *diskBudget) cost(size int64) int64 {
	if size == 0 {
		return b.block
	}
	if remainder := size % b.block; remainder != 0 {
		if size > math.MaxInt64-(b.block-remainder) {
			return math.MaxInt64
		}
		return size + b.block - remainder
	}
	return size
}

func (b *diskBudget) add(entry *diskEntry) {
	b.entries[entry.path] = b.lru.PushBack(entry)
	b.used += entry.size
}

func (b *diskBudget) forget(elem *list.Element) {
	entry := elem.Value.(*diskEntry)
	delete(b.entries, entry.path)
	b.lru.Remove(elem)
	b.used -= entry.size
}

func (b *diskBudget) touch(elem *list.Element) {
	if elem == nil || elem == b.lru.Back() {
		return
	}
	b.lru.MoveToBack(elem)
	now := time.Now()
	// The LRU order in memory is authoritative until restart.
	_ = os.Chtimes(elem.Value.(*diskEntry).path, now, now)
}

func (b *diskBudget) makeRoom(size int64) error {
	available := b.limit - b.reserved - size
	if b.used <= available {
		return nil
	}
	// Once full, leave 10% of the budget free when possible. A large upload
	// may require a lower target, and pinned readers may prevent reaching it.
	goal := min(available, b.limit-b.limit/10-b.reserved-size)
	for elem := b.lru.Front(); elem != nil && b.used > goal; {
		next := elem.Next()
		entry := elem.Value.(*diskEntry)
		if entry.pins == 0 {
			if err := os.Remove(entry.path); err != nil && !os.IsNotExist(err) {
				return fileError(err)
			}
			b.forget(elem)
		}
		elem = next
	}
	if b.used > available {
		return status.Error(codes.ResourceExhausted, "cache capacity is reserved by active reads or uploads")
	}
	return nil
}

func (b *diskBudget) reserve(size int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if size > b.limit-b.reserved {
		return status.Error(codes.ResourceExhausted, "upload exceeds available cache capacity")
	}
	if err := b.makeRoom(size); err != nil {
		return err
	}
	b.reserved += size
	return nil
}
