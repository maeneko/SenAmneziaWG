// Package logfmt turns the tunnel service's log lines into the form the app already reads from the
// macOS daemon: "LEVEL: message", nothing else (the app stamps its own time).
package logfmt

import (
	"regexp"
	"strings"
)

var (
	// The tunnel service logs "[TUN] [AmnesiaWG] message": ring tag, then the tunnel name.
	prefix  = regexp.MustCompile(`^\[[A-Z]{1,5}\]\s+(\[[^\]]*\]\s*)?`)
	errorRe = regexp.MustCompile(`(?i)\b(error|failed|failure|unable|cannot|can't|denied)\b`)
	warnRe  = regexp.MustCompile(`(?i)\bwarn(ing)?\b`)
)

// Normalize returns "" for a line with nothing to show.
func Normalize(line string) string {
	text := strings.TrimSpace(prefix.ReplaceAllString(strings.TrimSpace(line), ""))
	if text == "" {
		return ""
	}
	switch {
	case errorRe.MatchString(text):
		return "ERROR: " + text
	case warnRe.MatchString(text):
		return "WARNING: " + text
	}
	return "INFO: " + text
}
