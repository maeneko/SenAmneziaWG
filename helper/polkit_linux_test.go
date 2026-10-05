//go:build linux

package main

import (
	"encoding/xml"
	"strings"
	"testing"
)

// pkexec matches an action by the program's path and, when the action names one, by argv[1]. All the
// actions share the helper's path, so each must name its own subcommand: otherwise the first one pkexec
// finds — possibly `service`, which needs no password — would cover `pty` and `setup` as well.
func TestPolkitActionsNameTheirSubcommand(t *testing.T) {
	var doc struct {
		Actions []struct {
			ID       string `xml:"id,attr"`
			Annotate []struct {
				Key   string `xml:"key,attr"`
				Value string `xml:",chardata"`
			} `xml:"annotate"`
		} `xml:"action"`
	}
	body := strings.ReplaceAll(polkitPolicyTemplate, "{{HELPER}}", "/opt/SenAWG/resources/linux/awg-helper")
	// The DOCTYPE points at a URL encoding/xml does not fetch anyway; only the elements matter here.
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Actions) != 3 {
		t.Fatalf("%d actions, want 3", len(doc.Actions))
	}
	for _, a := range doc.Actions {
		want := strings.TrimPrefix(a.ID, "ru.senawg.helper.")
		got := map[string]string{}
		for _, n := range a.Annotate {
			got[n.Key] = n.Value
		}
		if got["org.freedesktop.policykit.exec.path"] != "/opt/SenAWG/resources/linux/awg-helper" {
			t.Errorf("%s: exec.path %q", a.ID, got["org.freedesktop.policykit.exec.path"])
		}
		if got["org.freedesktop.policykit.exec.argv1"] != want {
			t.Errorf("%s: exec.argv1 %q, want %q", a.ID, got["org.freedesktop.policykit.exec.argv1"], want)
		}
	}
}
