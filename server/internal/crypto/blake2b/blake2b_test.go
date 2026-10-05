package blake2b

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// Vectors from RFC 7693 Appendix A and the reference implementation.
func TestSum512(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"},
		{"abc", "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"},
		{"The quick brown fox jumps over the lazy dog", "a8add4bdddfd93e4877d2746e62817b116364a1fa7bc148d95090bc7333b3673f82401cf7aa2e4cb1ecd90296e3f14cb5413f8ed77be73045b13914cdcd6a918"},
	}
	for _, c := range cases {
		got := Sum512([]byte(c.in))
		if hex.EncodeToString(got[:]) != c.want {
			t.Errorf("Sum512(%q)\n got %s\nwant %s", c.in, hex.EncodeToString(got[:]), c.want)
		}
	}
}

func TestVariableSize(t *testing.T) {
	// BLAKE2b-256("abc")
	want := "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"
	got := Sum(32, []byte("abc"))
	if hex.EncodeToString(got) != want {
		t.Errorf("Sum(32)\n got %s\nwant %s", hex.EncodeToString(got), want)
	}
}

func TestKeyed(t *testing.T) {
	// RFC 7693 Appendix A style: keyed hash with key 00..3f, input 00.
	key := make([]byte, 64)
	for i := range key {
		key[i] = byte(i)
	}
	h, err := New(64, key)
	if err != nil {
		t.Fatal(err)
	}
	h.Write([]byte{0x00})
	got := h.Sum(nil)
	want, _ := hex.DecodeString("961f6dd1e4dd30f63901690c512e78e4b45e4742ed197c3c5e45c549fd25f2e4187b0bc9fe30492b16b0d0bc4ef9b0f34c7003fac09a5ef1532e69430234cebd")
	if !bytes.Equal(got, want) {
		t.Errorf("keyed\n got %x\nwant %x", got, want)
	}
}

func TestStreamingMatchesOneShot(t *testing.T) {
	data := make([]byte, 1000)
	for i := range data {
		data[i] = byte(i * 7)
	}
	one := Sum512(data)
	h, _ := New(64, nil)
	for i := 0; i < len(data); i += 37 {
		end := i + 37
		if end > len(data) {
			end = len(data)
		}
		h.Write(data[i:end])
	}
	if !bytes.Equal(h.Sum(nil), one[:]) {
		t.Error("streaming digest differs from one-shot")
	}
}
