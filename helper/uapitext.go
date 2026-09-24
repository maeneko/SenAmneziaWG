// uapitext.go is small pure-string handling of a UAPI body/answer, shared by every platform: Windows
// reads it off the tunnel service's pipe, Linux gets the same text straight back from device.IpcGet.
package main

import "strings"

// withoutSecrets drops key material from a `get=1` answer: the app never needs it, and keeping it on
// this side of the socket means it cannot end up in a log or a screenshot of one.
func withoutSecrets(uapi string) string {
	var keep []string
	for _, l := range strings.Split(uapi, "\n") {
		if strings.HasPrefix(l, "private_key=") || strings.HasPrefix(l, "preshared_key=") {
			continue
		}
		keep = append(keep, l)
	}
	return strings.Join(keep, "\n")
}

// endpointOf finds the peer's resolved address in a `get=1` answer.
func endpointOf(uapi string) string {
	for _, l := range strings.Split(uapi, "\n") {
		if v, ok := strings.CutPrefix(l, "endpoint="); ok {
			host := v
			if i := strings.LastIndex(v, ":"); i > 0 {
				host = strings.Trim(v[:i], "[]")
			}
			return host
		}
	}
	return ""
}

// allowedIPsOf collects every `allowed_ip=` line from a `set=1` body: what applyRoutes (route_linux.go)
// needs to know what to route onto the interface.
func allowedIPsOf(uapi string) []string {
	var out []string
	for _, l := range strings.Split(uapi, "\n") {
		if v, ok := strings.CutPrefix(l, "allowed_ip="); ok {
			out = append(out, v)
		}
	}
	return out
}
