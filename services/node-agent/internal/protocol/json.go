package protocol

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// Marshal encodes v like json.Marshal but without HTML escaping ("<", ">", "&" stay literal). Every
// frame the agent sends is encoded this way, so the JSON-encoded sizes the agent budgets for
// (jar.readEntries content) are the sizes on the wire.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte{'\n'}), nil
}

// JSONRuneLen is the number of bytes Marshal emits for r inside a string literal: "\"" and "\\" and
// the short escapes take 2, other C0 controls and U+2028/U+2029 take 6 ("\u00XX"), everything else
// its UTF-8 length. An invalid byte (invalid=true) is counted as 6: the classic encoder writes
// "\uFFFD", the jsonv2-backed one (Go 1.25+ default) a literal U+FFFD (3) — 6 is an upper bound.
func JSONRuneLen(r rune, invalid bool) int {
	switch {
	case invalid:
		return 6
	case r == '"' || r == '\\' || r == '\b' || r == '\f' || r == '\n' || r == '\r' || r == '\t':
		return 2
	case r < 0x20 || r == '\u2028' || r == '\u2029':
		return 6
	}
	return utf8.RuneLen(r)
}

// JSONStringLen is len(Marshal(s)) for valid UTF-8 (an upper bound otherwise), quotes included.
func JSONStringLen(s string) int {
	n := 2
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		n += JSONRuneLen(r, r == utf8.RuneError && size == 1)
		i += size
	}
	return n
}
