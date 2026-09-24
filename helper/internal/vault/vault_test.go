package vault

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPutGetDelete(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "secrets"))
	k := Keys{PrivateKey: "priv", PresharedKey: "psk"}
	if err := v.Put(1000, "abc-1", k); err != nil {
		t.Fatal(err)
	}
	got, err := v.Get(1000, "abc-1")
	if err != nil || got != k {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if _, err := v.Get(1001, "abc-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user's keys must not be visible: %v", err)
	}
	if err := v.Delete(1000, "abc-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Get(1000, "abc-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Delete: %v", err)
	}
	if err := v.Delete(1000, "abc-1"); err != nil {
		t.Fatalf("deleting nothing is fine: %v", err)
	}
}

func TestModes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "secrets")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	v := New(root)
	if err := v.Put(1000, "x", Keys{PrivateKey: "p"}); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{
		root:                                  0o700,
		filepath.Join(root, "1000"):           0o700,
		filepath.Join(root, "1000", "x.json"): 0o600,
	} {
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != want {
			t.Errorf("%s: mode %o, want %o", path, st.Mode().Perm(), want)
		}
	}
}
