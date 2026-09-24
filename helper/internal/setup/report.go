// Package setup holds the portable parts of `awg-helper setup`: the progress file the app follows, the
// argument parser, and the file copy with the bookkeeping a rollback needs. The Windows-only parts
// (service, registry, elevation) live in package main.
package setup

import (
	"encoding/json"
	"os"
	"sync"
)

// The steps the setup screen shows, in order (src/renderer/installer/index.html).
const (
	StepFiles   = 0 // «Файлы программы»
	StepService = 1 // «Служба подключения»
	StepStart   = 2 // «Запуск службы»
)

// Reporter appends one JSON object per line to the progress file. The elevated helper cannot share a
// pipe with the unelevated app, so the app creates this file and polls it (src/main/setup/progress.ts —
// the two must agree on these shapes):
//
//	{"step":0,"state":"active"}     {"step":0,"state":"done"}
//	{"failed":{"step":1,"message":"…"}}
//
// Every line is a single write, so the reader never sees half of one for long, and it ignores an
// unfinished last line anyway.
type Reporter struct {
	mu sync.Mutex
	f  *os.File
}

// NewReporter opens path for appending. An empty path gives a Reporter that discards everything, so
// `awg-helper setup` also works from a console.
//
// 0o644, not 0o600: on Windows the app has already created the file before elevating, so this mode
// only matters on Linux, where (unlike Windows) it is this process — running as root, via pkexec —
// that creates it fresh. The app that started it and reads this file back is not root, so the file must
// be world-readable; it holds nothing sensitive, only step/state lines (src/main/setup/progress.ts).
func NewReporter(path string) (*Reporter, error) {
	if path == "" {
		return &Reporter{}, nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	return &Reporter{f: f}, nil
}

type stepEvent struct {
	Step  int    `json:"step"`
	State string `json:"state"`
}

type failEvent struct {
	Failed failure `json:"failed"`
}

type failure struct {
	Step    int    `json:"step"`
	Message string `json:"message"`
}

func (r *Reporter) write(v any) {
	if r.f == nil {
		return
	}
	line, err := json.Marshal(v)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	_, _ = r.f.Write(append(line, '\n'))
}

func (r *Reporter) Active(step int) { r.write(stepEvent{step, "active"}) }
func (r *Reporter) Done(step int)   { r.write(stepEvent{step, "done"}) }

func (r *Reporter) Fail(step int, message string) { r.write(failEvent{failure{step, message}}) }

func (r *Reporter) Close() {
	if r.f != nil {
		_ = r.f.Close()
	}
}
