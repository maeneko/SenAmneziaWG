package proto

import (
	"strings"
	"testing"
)

func TestValidDomain(t *testing.T) {
	good := []string{"example.com", "a.b.example.co.uk", "xn--80ak6aa92e.com", "my-site.ru", "1c.ru"}
	bad := []string{"", "com", "1.2.3.4", "-a.com", "a-.com", "a..com", "Example.com", "a.com/x", "a b.com", "a.com.", "*.a.com",
		strings.Repeat("a", 64) + ".com", strings.Repeat("a.", 130) + "com", "a.com\n", "пример.рф"}
	for _, d := range good {
		if !ValidDomain(d) {
			t.Errorf("%q: want valid", d)
		}
	}
	for _, d := range bad {
		if ValidDomain(d) {
			t.Errorf("%q: want invalid", d)
		}
	}
}
