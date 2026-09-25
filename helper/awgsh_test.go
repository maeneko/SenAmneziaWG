package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"senawg-helper/internal/proto"
)

func hex64(c byte) string { return strings.Repeat(string(c), 64) }

func uapiBody(endpoint string, allowed ...string) string {
	b := "set=1\nprivate_key=" + hex64('1') + "\nreplace_peers=true\npublic_key=" + hex64('2') +
		"\nendpoint=" + endpoint + "\nreplace_allowed_ips=true\n"
	for _, a := range allowed {
		b += "allowed_ip=" + a + "\n"
	}
	return b
}

func upRequest() *proto.Request {
	return &proto.Request{
		V: proto.Version, Op: proto.OpUp, ID: "tun-1", Name: "Дом",
		Conf:    uapiBody("203.0.113.7:51820", "0.0.0.0/0", "::/0"),
		Address: []string{"10.8.0.2/32, fd00::2/128"}, Mtu: 1380, Dns: []string{"1.1.1.1", "2606:4700:4700::1111"},
		PID: 4242, UID: 501, UIDKnown: true,
	}
}

func TestAwgShUpArgs(t *testing.T) {
	req := upRequest()
	req.Replace, req.Diagnostics = true, true
	got, err := awgShUpArgs(req, "/Library/PrivilegedHelperTools/ru.senawg.helper/amneziawg-go", "/var/db/senawg/body.1", "SenAWG")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"up", "--id", "tun-1", "--uid", "501",
		"--bin", "/Library/PrivilegedHelperTools/ru.senawg.helper/amneziawg-go", "--body", "/var/db/senawg/body.1",
		"--endpoint-ip", "203.0.113.7", "--address", "10.8.0.2/32,fd00::2/128", "--allowed", "0.0.0.0/0,::/0",
		"--mtu", "1380", "--app-pid", "4242", "--app-cmd", "SenAWG",
		"--dns", "1.1.1.1,2606:4700:4700::1111", "--diagnostics", "1", "--replace", "1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestAwgShUpArgsIPv6EndpointAndDefaults(t *testing.T) {
	req := upRequest()
	req.Conf = uapiBody("[2001:db8::7]:51820", "10.0.0.0/8")
	req.Mtu, req.Dns = 0, nil
	got, err := awgShUpArgs(req, "/bin/awg", "/tmp/b", "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	for _, part := range []string{"--endpoint-ip 2001:db8::7", "--mtu 1280", "--allowed 10.0.0.0/8"} {
		if !strings.Contains(joined, part) {
			t.Errorf("%q missing from %q", part, joined)
		}
	}
	for _, absent := range []string{"--dns", "--app-cmd", "--diagnostics", "--replace"} {
		if strings.Contains(joined, absent) {
			t.Errorf("%q must not be passed: %q", absent, joined)
		}
	}
}

// Who asks is the kernel's to say: uid and pid are never decoded from the request itself.
func TestIdentityIsNotTakenFromJSON(t *testing.T) {
	var req proto.Request
	if err := json.Unmarshal([]byte(`{"v":1,"op":"up","UID":0,"uid":0,"UIDKnown":true,"uidKnown":true}`), &req); err != nil {
		t.Fatal(err)
	}
	if req.UIDKnown {
		t.Fatal("UIDKnown must not come from JSON")
	}
	req.PID = 1
	if _, err := awgShUpArgs(&req, "/bin/awg", "/tmp/b", ""); err == nil {
		t.Fatal("a request without a kernel-verified uid must be refused")
	}
}

func TestAwgShUpArgsRejects(t *testing.T) {
	cases := map[string]func(*proto.Request){
		"hostname endpoint": func(r *proto.Request) { r.Conf = uapiBody("vpn.example.com:51820", "0.0.0.0/0") },
		"shell in address":  func(r *proto.Request) { r.Address = []string{"10.8.0.2/32;id"} },
		"shell in dns":      func(r *proto.Request) { r.Dns = []string{"1.1.1.1 $(id)"} },
		"no allowed ips":    func(r *proto.Request) { r.Conf = uapiBody("203.0.113.7:51820") },
		"no pid":            func(r *proto.Request) { r.PID = 0 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			req := upRequest()
			mutate(req)
			if args, err := awgShUpArgs(req, "/bin/awg", "/tmp/b", ""); err == nil {
				t.Fatalf("accepted: %q", args)
			}
		})
	}
}

func TestParseStateEnv(t *testing.T) {
	text := "ID=tun-1\nIFACE=utun7\nPID=812\nSOCK=/var/run/amneziawg/utun7.sock\nDNS_OLD=''\n" +
		"DNS_SERVICE=Wi-Fi\\ 2\nMONITOR_PID=815\nAPP_PID=700\n"
	got := parseStateEnv(text)
	want := map[string]string{"ID": "tun-1", "IFACE": "utun7", "PID": "812", "MONITOR_PID": "815"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := parseStateEnv("PID=''\nIFACE=\n"); len(got) != 0 {
		t.Fatalf("empty values must be skipped, got %v", got)
	}
}

func TestSplitScriptOutput(t *testing.T) {
	warnings, rest := splitScriptOutput("warning: IPv6-маршрут не добавлен\nIFACE=utun7\n\n")
	if !reflect.DeepEqual(warnings, []string{"IPv6-маршрут не добавлен"}) || rest != "" {
		t.Fatalf("got %q / %q", warnings, rest)
	}
	_, rest = splitScriptOutput("warning: найдено устаревшее состояние, очищаю\nНет подключения к сети — не найден основной шлюз\n")
	if rest != "Нет подключения к сети — не найден основной шлюз" {
		t.Fatalf("rest %q", rest)
	}
}

func TestParseAwgGoVersion(t *testing.T) {
	if v := parseAwgGoVersion("amneziawg-go v3.1.20260828\n\nUserspace AmneziaWG daemon\n"); v != "v3.1.20260828" {
		t.Fatal(v)
	}
	if v := parseAwgGoVersion("garbage"); v != "unknown" {
		t.Fatal(v)
	}
}
