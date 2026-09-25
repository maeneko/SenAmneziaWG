package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"

	"senawg-helper/internal/proto"
	"senawg-helper/internal/vault"
)

// The vector is the one tests/senLink.test.ts checks against the server's own codec: seed 03…03 signing
// this request string must give this signature, whichever side computes it.
const (
	senVectorMsg = "GET\n/sub/v1/config\n1700000000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	senVectorSig = "e7SRRBNFrfcJovCNq0M2OpelKyF0tXXvOzYSt5A9CwpDETbJrF3GgLMnVE_FcH4sj4avLCkG3C5_gCnczbLaAA"
)

func senController(t *testing.T) *controller {
	t.Helper()
	return &controller{vault: vault.New(t.TempDir())}
}

func TestSenSignMatchesTheServersVector(t *testing.T) {
	c := senController(t)
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = 3
	}
	const id = "sen-0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"
	if err := c.vault.Put(1000, id, vault.Keys{PrivateKey: base64.StdEncoding.EncodeToString(seed)}); err != nil {
		t.Fatal(err)
	}
	resp, err := c.senSign(&proto.Request{ID: id, Message: senVectorMsg, UID: 1000, UIDKnown: true})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Sig != senVectorSig {
		t.Fatalf("signature %q, want %q", resp.Sig, senVectorSig)
	}
}

func TestSenSignIsPerUserAndPerKey(t *testing.T) {
	c := senController(t)
	const id = "sen-a"
	_ = c.vault.Put(1000, id, vault.Keys{PrivateKey: base64.StdEncoding.EncodeToString(make([]byte, 32))})

	if _, err := c.senSign(&proto.Request{ID: id, Message: senVectorMsg, UID: 1001, UIDKnown: true}); err == nil {
		t.Error("another user signed with this user's key")
	}
	if _, err := c.senSign(&proto.Request{ID: id, Message: senVectorMsg}); err == nil {
		t.Error("signed without knowing who asked")
	}
	if _, err := c.senSign(&proto.Request{ID: "sen-b", Message: senVectorMsg, UID: 1000, UIDKnown: true}); err == nil {
		t.Error("signed with a key that is not there")
	}
	if _, err := c.senSign(&proto.Request{ID: id, Message: "anything else", UID: 1000, UIDKnown: true}); err == nil {
		t.Error("signed a message that is not a subscription request")
	}
}

func TestSenSignRefusesACorruptKey(t *testing.T) {
	c := senController(t)
	_ = c.vault.Put(1000, "sen-a", vault.Keys{PrivateKey: base64.StdEncoding.EncodeToString([]byte("short"))})
	if _, err := c.senSign(&proto.Request{ID: "sen-a", Message: senVectorMsg, UID: 1000, UIDKnown: true}); err == nil {
		t.Error("a key of the wrong length signed")
	}
}
