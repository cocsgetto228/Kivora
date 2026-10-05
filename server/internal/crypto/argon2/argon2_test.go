package argon2

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// TestRFC9106Vector is the known-answer test printed in RFC 9106 section 5.3.
// If this passes, this implementation agrees with the specification byte for
// byte, including the secret and associated-data inputs.
func TestRFC9106Vector(t *testing.T) {
	password := bytes.Repeat([]byte{0x01}, 32)
	salt := bytes.Repeat([]byte{0x02}, 16)
	secret := bytes.Repeat([]byte{0x03}, 8)
	data := bytes.Repeat([]byte{0x04}, 12)

	got := Key(password, salt, secret, data, 3, 32, 4, 32)
	want := "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
	if hex.EncodeToString(got) != want {
		t.Fatalf("Argon2id\n got %s\nwant %s", hex.EncodeToString(got), want)
	}
}

func TestIDKeyDeterministic(t *testing.T) {
	a := IDKey([]byte("correct horse battery staple"), []byte("0123456789abcdef"), 2, 1<<10, 2, 32)
	b := IDKey([]byte("correct horse battery staple"), []byte("0123456789abcdef"), 2, 1<<10, 2, 32)
	if !bytes.Equal(a, b) {
		t.Fatal("same inputs produced different keys")
	}
	c := IDKey([]byte("correct horse battery stapl3"), []byte("0123456789abcdef"), 2, 1<<10, 2, 32)
	if bytes.Equal(a, c) {
		t.Fatal("different passwords produced the same key")
	}
}

func TestLongOutput(t *testing.T) {
	// Exercises the H' chaining path used for outputs longer than 64 bytes.
	k := IDKey([]byte("pw"), []byte("saltsaltsaltsalt"), 1, 1<<10, 1, 300)
	if len(k) != 300 {
		t.Fatalf("want 300 bytes, got %d", len(k))
	}
	if bytes.Equal(k[:64], make([]byte, 64)) {
		t.Fatal("output looks empty")
	}
}

func BenchmarkIDKeyDefaults(b *testing.B) {
	salt := []byte("0123456789abcdef")
	for i := 0; i < b.N; i++ {
		IDKey([]byte("benchmark password"), salt, 3, 64*1024, 2, 32)
	}
}
