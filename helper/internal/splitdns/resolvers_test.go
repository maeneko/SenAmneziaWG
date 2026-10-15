package splitdns

import (
	"net/netip"
	"testing"
)

func TestParseResolvConf(t *testing.T) {
	text := "# comment\nnameserver 127.0.0.53\nnameserver 192.168.1.1\nnameserver  8.8.8.8  \nnameserver 192.168.1.1\nnameserver fe80::1\nnameserver ::1\nnameserver 2001:4860:4860::8888\nsearch lan\nnameserver bogus\nnameserver\n"
	got := ParseResolvConf(text)
	want := []netip.Addr{netip.MustParseAddr("192.168.1.1"), netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("2001:4860:4860::8888")}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if len(ParseResolvConf("nameserver 127.0.0.1\n")) != 0 {
		t.Fatal("a loopback-only resolv.conf has no direct servers")
	}
}
