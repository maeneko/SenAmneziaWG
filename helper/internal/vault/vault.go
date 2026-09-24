// Package vault keeps tunnel keys on the service's side, for a Linux desktop with no Secret Service or
// KWallet for the app's own safeStorage (src/main/store.ts). It is the same arrangement NetworkManager
// (/etc/NetworkManager/system-connections) and wg-quick (/etc/wireguard) use: plain files only root can
// read. Other programs of the same user cannot read them either — the keys never leave the service
// once put — which is more than the "basic" password store Chromium would otherwise fall back to.
//
// Layout: <dir>/<uid>/<tunnel id>.json, directories 0700, files 0600. Keys are per local user, the
// uid coming from the socket (SO_PEERCRED), so one user can neither use nor replace another's.
package vault

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
)

// ErrNotFound is returned by Get when nothing is kept for that user and id.
var ErrNotFound = errors.New("ключи не найдены")

type Vault struct{ dir string }

func New(dir string) *Vault { return &Vault{dir: dir} }

// Keys are stored as the app sent them: base64, as in a .conf.
type Keys struct {
	PrivateKey   string `json:"privateKey"`
	PresharedKey string `json:"presharedKey,omitempty"`
}

// The id is validated by the caller (proto.ValidateSecretID: letters, digits and '-'), so it is safe as
// a file name.
func (v *Vault) userDir(uid uint32) string {
	return filepath.Join(v.dir, strconv.FormatUint(uint64(uid), 10))
}

func (v *Vault) path(uid uint32, id string) string {
	return filepath.Join(v.userDir(uid), id+".json")
}

// Put writes the keys, replacing any kept under the same id. Write-then-rename, so a crash never
// leaves a half-written key behind.
func (v *Vault) Put(uid uint32, id string, k Keys) error {
	dir := v.userDir(uid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// MkdirAll leaves an existing directory's mode alone; make sure nothing ever widened it.
	for _, d := range []string{v.dir, dir} {
		if err := os.Chmod(d, 0o700); err != nil {
			return err
		}
	}
	b, err := json.Marshal(k)
	if err != nil {
		return err
	}
	tmp := v.path(uid, id) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, v.path(uid, id))
}

func (v *Vault) Get(uid uint32, id string) (Keys, error) {
	b, err := os.ReadFile(v.path(uid, id))
	if errors.Is(err, fs.ErrNotExist) {
		return Keys{}, ErrNotFound
	}
	if err != nil {
		return Keys{}, err
	}
	var k Keys
	if err := json.Unmarshal(b, &k); err != nil {
		return Keys{}, err
	}
	return k, nil
}

// Delete forgets one tunnel's keys. Nothing kept is not an error: the goal is that nothing is kept.
func (v *Vault) Delete(uid uint32, id string) error {
	err := os.Remove(v.path(uid, id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
