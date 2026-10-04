package setup

import "strings"

// AppDir is where the application really goes for the folder the user picked: always a folder named
// SenAWG. Choosing D:\Programs puts it in D:\Programs\SenAWG, not loose among everything else in
// there — otherwise uninstalling would have no way to tell its own files from the user's. The same on
// Linux, with its own separator: /home/ivan/Apps becomes /home/ivan/Apps/SenAWG, never /home/ivan/Apps\SenAWG.
// Written by hand on both separators, so it means the same on every platform (the tests run on macOS).
func AppDir(picked string) string {
	p := strings.TrimRight(strings.TrimSpace(picked), `\/`)
	if p == "" {
		return ""
	}
	cut := strings.LastIndexAny(p, `\/`)
	if strings.EqualFold(p[cut+1:], "SenAWG") {
		return p
	}
	// A Unix path is absolute from its first character; a Windows one starts with a drive or a share.
	if strings.HasPrefix(p, "/") {
		return p + "/SenAWG"
	}
	// «D:» alone is a drive root; the separator goes back on so the result is D:\SenAWG.
	return p + `\SenAWG`
}
