package lifetime

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// procs stands in for the processes the service waits on: each pid exits when the test says so.
type procs struct {
	mu   sync.Mutex
	exit map[uint32]chan struct{}
}

func newProcs() *procs { return &procs{exit: map[uint32]chan struct{}{}} }

func (p *procs) ch(pid uint32) chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exit[pid] == nil {
		p.exit[pid] = make(chan struct{})
	}
	return p.exit[pid]
}

func (p *procs) await(pid uint32) error { <-p.ch(pid); return nil }
func (p *procs) kill(pid uint32)        { close(p.ch(pid)) }

func stopped(l *Lifetime, within time.Duration) (string, bool) {
	select {
	case why := <-l.Done():
		return why, true
	case <-time.After(within):
		return "", false
	}
}

func TestStopsWhenTheAppExits(t *testing.T) {
	p := newProcs()
	l := New(p.await)
	l.Watch(100)
	if _, ok := stopped(l, 30*time.Millisecond); ok {
		t.Fatal("stopped while the app is still running")
	}
	p.kill(100)
	if _, ok := stopped(l, time.Second); !ok {
		t.Fatal("did not stop after the app exited")
	}
}

func TestFollowsTheLatestApp(t *testing.T) {
	p := newProcs()
	l := New(p.await)
	l.Watch(100)
	l.Watch(200) // the app restarted and the new one spoke first
	p.kill(100)
	if _, ok := stopped(l, 50*time.Millisecond); ok {
		t.Fatal("the exit of an app no longer followed stopped the service")
	}
	p.kill(200)
	if _, ok := stopped(l, time.Second); !ok {
		t.Fatal("did not stop after the followed app exited")
	}
}

func TestRepeatedAndEmptyPidsChangeNothing(t *testing.T) {
	var calls int
	var mu sync.Mutex
	exit := make(chan struct{})
	l := New(func(uint32) error {
		mu.Lock()
		calls++
		mu.Unlock()
		<-exit
		return nil
	})
	l.Watch(100)
	l.Watch(100)
	l.Watch(0)
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("waited on the process %d times", calls)
	}
	close(exit)
}

// A pid that cannot even be opened belongs to a process that is already gone.
func TestAnAppThatCannotBeWatchedCountsAsGone(t *testing.T) {
	l := New(func(uint32) error { return errors.New("no such process") })
	l.Watch(100)
	if _, ok := stopped(l, time.Second); !ok {
		t.Fatal("did not stop")
	}
}

func TestStopsWhenNobodyComes(t *testing.T) {
	l := New(newProcs().await)
	l.Idle(20 * time.Millisecond)
	if _, ok := stopped(l, time.Second); !ok {
		t.Fatal("an unused service kept running")
	}
}

func TestIdleDoesNothingOnceAnAppCame(t *testing.T) {
	l := New(newProcs().await)
	l.Idle(20 * time.Millisecond)
	l.Watch(100)
	if _, ok := stopped(l, 80*time.Millisecond); ok {
		t.Fatal("stopped under a running app")
	}
}

func TestNothingFiresAfterClose(t *testing.T) {
	p := newProcs()
	l := New(p.await)
	l.Watch(100)
	l.Idle(10 * time.Millisecond)
	l.Close()
	p.kill(100)
	if _, ok := stopped(l, 50*time.Millisecond); ok {
		t.Fatal("asked to stop a service that is already stopping")
	}
	l.Watch(200) // a late request while stopping arms nothing
	p.kill(200)
	if _, ok := stopped(l, 50*time.Millisecond); ok {
		t.Fatal("a request after Close armed a watcher")
	}
}

func TestAsksToStopOnlyOnce(t *testing.T) {
	p := newProcs()
	l := New(p.await)
	l.Watch(100)
	l.Idle(1 * time.Millisecond)
	p.kill(100)
	if _, ok := stopped(l, time.Second); !ok {
		t.Fatal("did not stop")
	}
	if _, ok := stopped(l, 50*time.Millisecond); ok {
		t.Fatal("asked to stop twice")
	}
}
