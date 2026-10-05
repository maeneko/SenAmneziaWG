//go:build linux || darwin

package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// RootOnly checks that nobody but root can change what ends up at dir. Root runs the installed helper
// (pkexec, polkit's «yes» for `service`), so if any directory on the way to it is someone else's, or
// writable by others, they can rename the install away and put their own helper in its place.
//
// Every existing component of the path is checked as written (Lstat: a link is judged by its own owner)
// and again with the links resolved, since root follows them later. Components not there yet are fine:
// setup creates them itself, as root, 0755.
func RootOnly(dir string) error {
	dir = filepath.Clean(dir)
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("%s: нужен абсолютный путь", dir)
	}
	deepest := ""
	for d := dir; ; d = filepath.Dir(d) {
		fi, err := os.Lstat(d)
		switch {
		case err == nil:
			if deepest == "" {
				deepest = d
			}
			if err := rootOnly(d, fi); err != nil {
				return err
			}
		case !os.IsNotExist(err):
			return err
		}
		if filepath.Dir(d) == d {
			break
		}
	}
	real, err := filepath.EvalSymlinks(deepest)
	if err != nil {
		return err
	}
	for d := real; ; d = filepath.Dir(d) {
		fi, err := os.Stat(d)
		if err != nil {
			return err
		}
		if err := rootOnly(d, fi); err != nil {
			return err
		}
		if filepath.Dir(d) == d {
			return nil
		}
	}
}

func rootOnly(path string, fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: не удалось узнать владельца", path)
	}
	if st.Uid != 0 {
		return fmt.Errorf("%s принадлежит не root", path)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil // a link's own mode means nothing; its target is checked on the resolved pass
	}
	perm := fi.Mode().Perm()
	if perm&0o002 != 0 || (perm&0o020 != 0 && st.Gid != 0) {
		return fmt.Errorf("в %s может писать не только root", path)
	}
	return nil
}
