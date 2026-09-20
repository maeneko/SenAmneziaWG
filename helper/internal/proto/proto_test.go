package proto

import (
	"bufio"
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestReadRequest(t *testing.T) {
	req, err := ReadRequest(bufio.NewReader(strings.NewReader(`{"v":1,"op":"up","id":"abc","replace":true}` + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if req.Op != OpUp || req.ID != "abc" || !req.Replace || req.V != 1 {
		t.Fatalf("unexpected request: %+v", req)
	}
}

func TestReadRequestWithoutTrailingNewline(t *testing.T) {
	req, err := ReadRequest(bufio.NewReader(strings.NewReader(`{"v":1,"op":"status"}`)))
	if err != nil || req.Op != OpStatus {
		t.Fatalf("got %+v, %v", req, err)
	}
}

func TestReadRequestRejectsMalformedAndOversized(t *testing.T) {
	if _, err := ReadRequest(bufio.NewReader(strings.NewReader("not json\n"))); err == nil {
		t.Fatal("malformed JSON was accepted")
	}
	huge := `{"v":1,"op":"up","conf":"` + strings.Repeat("a", MaxLine) + `"}` + "\n"
	if _, err := ReadRequest(bufio.NewReader(strings.NewReader(huge))); !errors.Is(err, errLineTooLong) {
		t.Fatalf("oversized request: got %v", err)
	}
	if _, err := ReadRequest(bufio.NewReader(strings.NewReader(""))); err == nil {
		t.Fatal("empty input was accepted")
	}
}

func TestWriteResponseIsOneLine(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteResponse(&buf, &Response{OK: true, UAPI: "a=1\nb=2\n\n"}); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
		t.Fatalf("response must be exactly one line, got %q", out)
	}
}

func TestFail(t *testing.T) {
	r := Fail(Errf(CodeBusy, "занято"))
	if r.OK || r.Code != CodeBusy || r.Error != "занято" {
		t.Fatalf("unexpected: %+v", r)
	}
	r = Fail(errors.New("boom"))
	if r.Code != CodeInternal || !strings.Contains(r.Error, "boom") {
		t.Fatalf("unexpected: %+v", r)
	}
}
