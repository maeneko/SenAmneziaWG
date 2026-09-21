package main

import (
	"os"
	"sync"
	"time"

	"github.com/amnezia-vpn/amneziawg-windows/v3/ringlogger"

	"senawg-helper/internal/logfmt"
)

const recentLines = 20

// logMirror copies the tunnel service's log into daemon.log. The tunnel writes to a shared-memory ring
// (data\log.bin) that only SYSTEM can open; the app follows the plain file instead, exactly as it
// follows the daemon's log on macOS.
type logMirror struct {
	d      dirs
	rl     *ringlogger.Ringlogger
	mu     sync.Mutex
	cursor uint32
	file   *os.File
	recent []string
	stop   chan struct{}
	done   chan struct{}
}

func newLogMirror(d dirs) (*logMirror, error) {
	rl, err := ringlogger.NewRinglogger(d.ringPath(), "MGR")
	if err != nil {
		return nil, err
	}
	m := &logMirror{d: d, rl: rl, stop: make(chan struct{}), done: make(chan struct{})}
	// The ring outlives reboots; what earlier sessions left in it is not this session's business.
	_, m.cursor = rl.FollowFromCursor(ringlogger.CursorAll)
	// Append: a tunnel that survived a restart of this service keeps its history.
	if m.file, err = os.OpenFile(d.daemonLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err != nil {
		return nil, err
	}
	go m.loop()
	return m, nil
}

func (m *logMirror) loop() {
	defer close(m.done)
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			m.Drain()
		case <-m.stop:
			return
		}
	}
}

// Reset starts a fresh daemon.log (a new file, so the app's follower re-reads it from the top) and
// makes the mirror skip everything the ring already holds.
func (m *logMirror) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.file != nil {
		m.file.Close()
		m.file = nil
	}
	_ = os.Remove(m.d.daemonLog())
	m.file, _ = os.OpenFile(m.d.daemonLog(), os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o644)
	m.recent = nil
	_, m.cursor = m.rl.FollowFromCursor(ringlogger.CursorAll)
}

// Drain copies whatever the tunnel service logged since the last call.
func (m *logMirror) Drain() {
	m.mu.Lock()
	defer m.mu.Unlock()
	lines, next := m.rl.FollowFromCursor(m.cursor)
	m.cursor = next
	for _, l := range lines {
		m.writeLocked(logfmt.Normalize(l.Line))
	}
}

// Note adds a line of the helper's own.
func (m *logMirror) Note(text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writeLocked("INFO: Служба: " + text)
}

// Tail returns the last few lines, for an error message when the tunnel does not start.
func (m *logMirror) Tail(n int) []string {
	m.Drain()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.recent) < n {
		n = len(m.recent)
	}
	return append([]string(nil), m.recent[len(m.recent)-n:]...)
}

func (m *logMirror) writeLocked(line string) {
	if line == "" {
		return
	}
	m.recent = append(m.recent, line)
	if len(m.recent) > recentLines {
		m.recent = m.recent[len(m.recent)-recentLines:]
	}
	if m.file != nil {
		_, _ = m.file.WriteString(line + "\r\n")
	}
}

func (m *logMirror) Close() {
	close(m.stop)
	<-m.done
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.file != nil {
		m.file.Close()
		m.file = nil
	}
	m.rl.Close()
}
