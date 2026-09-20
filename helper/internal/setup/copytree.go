package setup

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// CopyTree copies the directory from into to. It returns what it CREATED — directories and files that
// were not there before — in creation order, so a failed install can take back exactly that and leave
// alone whatever the user already had in the folder they picked. Files that already existed are
// overwritten and are not listed: an update cannot be rolled back file by file.
func CopyTree(from, to string) (created []string, err error) {
	root := filepath.Clean(from)
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		dst := filepath.Join(to, rel)
		switch {
		case d.IsDir():
			isNew := !exists(dst)
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			if isNew {
				created = append(created, dst)
			}
			return nil
		case d.Type().IsRegular():
			isNew := !exists(dst)
			if err := copyFile(path, dst); err != nil {
				return err
			}
			if isNew {
				created = append(created, dst)
			}
			return nil
		default:
			// A payload has no links or devices; refusing beats following one out of the tree.
			return fmt.Errorf("%s: не обычный файл", path)
		}
	})
	return created, err
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Undo removes what CopyTree created, newest first, so directories go after their contents. A directory
// that is not empty (the user put something there since) is left, not forced.
func Undo(created []string) {
	for i := len(created) - 1; i >= 0; i-- {
		_ = os.Remove(created[i])
	}
}

// MkdirAllTracked is os.MkdirAll that reports which directories it had to create, outermost first, so
// Undo can take back exactly those.
func MkdirAllTracked(dir string) ([]string, error) {
	var missing []string
	for d := filepath.Clean(dir); !exists(d); {
		missing = append([]string{d}, missing...)
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return missing, nil
}
