package setup

import (
	"fmt"
	"os"
	"time"
)

// The seamless update: the new version is copied beside the installed one (`<app>.next`) while the
// application keeps running, and once it has exited the two folders trade places (`<app>.old` holds the
// previous one until the update is known to have worked). Only the swap happens with the application
// closed, and a rename takes a moment where copying 200 MB takes seconds.

func NextDir(appDir string) string { return appDir + ".next" }
func OldDir(appDir string) string  { return appDir + ".old" }

// Stage copies from into a fresh NextDir. Whatever a previous, abandoned attempt left there is removed
// first, and a failed copy leaves nothing behind.
func Stage(from, appDir string) error {
	next := NextDir(appDir)
	if err := os.RemoveAll(next); err != nil {
		return fmt.Errorf("не удалось убрать %s: %w", next, err)
	}
	if err := os.MkdirAll(next, 0o755); err != nil {
		return err
	}
	if _, err := CopyTree(from, next); err != nil {
		_ = os.RemoveAll(next)
		return err
	}
	return nil
}

// DiscardStage removes what Stage made, for an update that ends before the swap.
func DiscardStage(appDir string) { _ = os.RemoveAll(NextDir(appDir)) }

// Swap makes the staged folder the installed one. Returns what takes it back: the old folder returns and
// the new one goes, for a later step that fails. Renaming a folder fails on Windows while any process still
// holds a file in it (antivirus, a lingering handle), so it is retried for a couple of seconds.
func Swap(appDir string) (rollback func(), err error) {
	next, old := NextDir(appDir), OldDir(appDir)
	if !exists(next) {
		return nil, fmt.Errorf("нет подготовленной версии %s", next)
	}
	if err := os.RemoveAll(old); err != nil {
		return nil, fmt.Errorf("не удалось убрать %s: %w", old, err)
	}
	hadOld := exists(appDir)
	if hadOld {
		if err := renameRetry(appDir, old); err != nil {
			return nil, fmt.Errorf("не удалось отодвинуть прежнюю версию: %w", err)
		}
	}
	if err := renameRetry(next, appDir); err != nil {
		if hadOld {
			_ = os.Rename(old, appDir)
		}
		return nil, fmt.Errorf("не удалось поставить новую версию: %w", err)
	}
	return func() {
		if !hadOld {
			return
		}
		_ = os.RemoveAll(appDir)
		_ = renameRetry(old, appDir)
	}, nil
}

// DiscardOld drops the previous version after a successful update. Best effort: a locked file leaves a
// folder that the next update removes anyway (Swap clears it first).
func DiscardOld(appDir string) {
	for i := 0; i < 10; i++ {
		if os.RemoveAll(OldDir(appDir)) == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func renameRetry(from, to string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}
