package xref

import (
	"container/list"
	"errors"
	"sync"
)

// ErrNotModified signals an upstream 304 for a conditional revalidation.
var ErrNotModified = errors.New("xref: not modified")

// Entry is a cached page decomposition.
type Entry struct {
	Split *Split
	ETag  string
}

func (e *Entry) size() int64 {
	if e == nil || e.Split == nil {
		return 0
	}
	n := int64(len(e.Split.Head) + len(e.Split.Tail))
	for _, l := range e.Split.Lines {
		n += int64(len(l))
	}
	return n
}

// Cache is a size-bounded LRU cache of page splits. It is safe for
// concurrent use.
type Cache struct {
	mu       sync.Mutex
	maxBytes int64
	curBytes int64
	entries  map[string]*list.Element
	order    *list.List // front = most recently used
}

type cacheItem struct {
	key   string
	entry *Entry
}

// NewCache returns a cache evicting beyond maxBytes (0 = 128MiB default).
func NewCache(maxBytes int64) *Cache {
	if maxBytes <= 0 {
		maxBytes = 128 << 20
	}
	return &Cache{
		maxBytes: maxBytes,
		entries:  make(map[string]*list.Element),
		order:    list.New(),
	}
}

// Get returns the cached entry for key, if present, marking it recent.
func (c *Cache) Get(key string) (*Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*cacheItem).entry, true
}

// Put stores an entry for key, evicting least-recently-used items when the
// size budget is exceeded.
func (c *Cache) Put(key string, e *Entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[key]; ok {
		item := el.Value.(*cacheItem)
		c.curBytes -= item.entry.size()
		c.order.Remove(el)
		delete(c.entries, key)
	}
	el := c.order.PushFront(&cacheItem{key, e})
	c.entries[key] = el
	c.curBytes += e.size()
	for c.curBytes > c.maxBytes && c.order.Len() > 1 {
		last := c.order.Back()
		if last == nil {
			break
		}
		item := last.Value.(*cacheItem)
		c.curBytes -= item.entry.size()
		c.order.Remove(last)
		delete(c.entries, item.key)
	}
}
