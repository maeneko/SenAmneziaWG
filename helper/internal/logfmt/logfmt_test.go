package logfmt

import "testing"

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"[TUN] [AmnesiaWG] Starting AmneziaWG/0.1":                           "INFO: Starting AmneziaWG/0.1",
		"[TUN] [AmnesiaWG] peer(abcd…wxyz) - Sending handshake initiation":   "INFO: peer(abcd…wxyz) - Sending handshake initiation",
		"[TUN] [AmnesiaWG] Failed to create Wintun: access denied":           "ERROR: Failed to create Wintun: access denied",
		"[TUN] Service run error: The system cannot find the file specified": "ERROR: Service run error: The system cannot find the file specified",
		"[TUN] [AmnesiaWG] Warning: unable to determine Wintun version":      "ERROR: Warning: unable to determine Wintun version",
		"[TUN] [AmnesiaWG] Warning: something odd":                           "WARNING: Warning: something odd",
		"no prefix at all":     "INFO: no prefix at all",
		"[TUN] [AmnesiaWG]   ": "",
		"":                     "",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
