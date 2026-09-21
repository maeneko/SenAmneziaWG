// Package lifetime decides when the helper service stops: exactly when the app it serves is gone.
//
// The service is started on demand by the app and is worth nothing without it — a tunnel nobody can see
// or switch off is worse than none. So it follows one app process at a time (the latest one to send a
// request) and asks to stop once that process has exited, or once nobody has come at all.
package lifetime

import (
	"fmt"
	"sync"
	"time"
)

// Lifetime is safe for concurrent use: requests arrive on their own goroutines.
type Lifetime struct {
	// await blocks until the process exits. An error means it cannot be watched, which for a pid a
	// request has just named means it is already gone.
	await func(pid uint32) error

	mu     sync.Mutex
	pid    uint32
	gen    uint64 // bumped on every new pid, so the watcher of a previous one does nothing
	closed bool
	done   chan string
}

func New(await func(pid uint32) error) *Lifetime {
	return &Lifetime{await: await, done: make(chan string, 1)}
}

// Done delivers, once, why the service should stop.
func (l *Lifetime) Done() <-chan string { return l.done }

// Watch follows pid from now on. Every request calls it; the same pid again, or none, changes nothing.
func (l *Lifetime) Watch(pid uint32) {
	l.mu.Lock()
	if pid == 0 || pid == l.pid || l.closed {
		l.mu.Unlock()
		return
	}
	l.pid = pid
	l.gen++
	gen := l.gen
	l.mu.Unlock()

	go func() {
		_ = l.await(pid)
		l.finish(func() bool { return l.gen == gen }, fmt.Sprintf("приложение закрыто (pid %d) — останавливаю службу", pid))
	}()
}

// Idle stops the service if no app has made itself known within d: a service started by a crash
// recovery, by hand or by an installer whose window was closed has nobody to serve.
func (l *Lifetime) Idle(d time.Duration) {
	time.AfterFunc(d, func() {
		l.finish(func() bool { return l.pid == 0 }, "приложение не подключилось — останавливаю службу")
	})
}

// Close is called when the service stops for another reason (the SCM asked): nothing may fire after.
func (l *Lifetime) Close() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
}

func (l *Lifetime) finish(still func() bool, why string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || !still() {
		return
	}
	l.closed = true
	l.done <- why
}
