package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// A tiny, dependency-free re-implementation of the subset of zod used by the command payload
// schemas. Semantics mirror zod v4: objects strip unknown keys; `optional` accepts a missing
// key only (JSON has no `undefined`); `nullable` accepts null; `default` substitutes a value
// for a missing key; string lengths count UTF-16 code units like JavaScript; `int` means a
// safe integer. Validation runs on the generic decoded JSON value, then the cleaned value
// (with defaults applied) is decoded into the typed payload struct.

// Issue is one validation failure, reported in VALIDATION_FAILED details.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type issues struct{ list []Issue }

func (is *issues) add(path, format string, args ...any) {
	if len(is.list) < 32 {
		is.list = append(is.list, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}
}

// Schema validates a decoded JSON value and returns the cleaned value.
type Schema interface {
	check(v any, path string, is *issues) any
}

func joinPath(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}

// --- presence wrappers -------------------------------------------------------------------

type optionalSchema struct{ inner Schema }
type defaultSchema struct {
	inner Schema
	def   func() any
}
type nullableSchema struct{ inner Schema }

// Optional allows the key to be absent.
func Optional(s Schema) Schema { return optionalSchema{s} }

// Default substitutes def() when the key is absent (the default itself is not re-validated, as in zod).
func Default(s Schema, def func() any) Schema { return defaultSchema{s, def} }

// Nullable additionally accepts JSON null.
func Nullable(s Schema) Schema { return nullableSchema{s} }

func (o optionalSchema) check(v any, p string, is *issues) any { return o.inner.check(v, p, is) }
func (d defaultSchema) check(v any, p string, is *issues) any  { return d.inner.check(v, p, is) }
func (n nullableSchema) check(v any, p string, is *issues) any {
	if v == nil {
		return nil
	}
	return n.inner.check(v, p, is)
}

// --- object ------------------------------------------------------------------------------

type field struct {
	name   string
	schema Schema
}

// ObjectSchema is a zod object (non-strict: unknown keys are stripped).
type ObjectSchema struct{ fields []field }

// F declares an object field.
func F(name string, s Schema) field { return field{name, s} }

// Obj builds an object schema.
func Obj(fields ...field) *ObjectSchema { return &ObjectSchema{fields: fields} }

// Extend returns a copy with additional fields (later fields override earlier ones by name).
func (o *ObjectSchema) Extend(fields ...field) *ObjectSchema {
	out := &ObjectSchema{}
	for _, f := range o.fields {
		replaced := false
		for _, nf := range fields {
			if nf.name == f.name {
				replaced = true
			}
		}
		if !replaced {
			out.fields = append(out.fields, f)
		}
	}
	out.fields = append(out.fields, fields...)
	return out
}

func (o *ObjectSchema) check(v any, p string, is *issues) any {
	m, ok := v.(map[string]any)
	if !ok {
		is.add(p, "expected object")
		return nil
	}
	out := make(map[string]any, len(o.fields))
	for _, f := range o.fields {
		val, present := m[f.name]
		if !present {
			switch s := f.schema.(type) {
			case optionalSchema:
				continue
			case defaultSchema:
				out[f.name] = s.def()
				continue
			default:
				is.add(joinPath(p, f.name), "required")
				continue
			}
		}
		out[f.name] = f.schema.check(val, joinPath(p, f.name), is)
	}
	return out
}

// --- string ------------------------------------------------------------------------------

// StringSchema validates strings. Builder methods return copies so base schemas can be reused.
type StringSchema struct {
	min, max int
	patterns []*regexp.Regexp
	enum     []string
	refines  []func(string) string
	httpsURL bool
	anyOf    []*regexp.Regexp
}

// Str builds a string schema.
func Str() *StringSchema { return &StringSchema{min: -1, max: -1} }

func (s *StringSchema) clone() *StringSchema {
	c := *s
	c.patterns = append([]*regexp.Regexp(nil), s.patterns...)
	c.refines = append([]func(string) string(nil), s.refines...)
	c.anyOf = append([]*regexp.Regexp(nil), s.anyOf...)
	return &c
}

func (s *StringSchema) Min(n int) *StringSchema { c := s.clone(); c.min = n; return c }
func (s *StringSchema) Max(n int) *StringSchema { c := s.clone(); c.max = n; return c }
func (s *StringSchema) Regex(re string) *StringSchema {
	c := s.clone()
	c.patterns = append(c.patterns, regexp.MustCompile(re))
	return c
}

// OneOfRegex passes if any of the patterns match (z.union of string formats).
func (s *StringSchema) OneOfRegex(res ...string) *StringSchema {
	c := s.clone()
	for _, r := range res {
		c.anyOf = append(c.anyOf, regexp.MustCompile(r))
	}
	return c
}
func (s *StringSchema) Enum(vals ...string) *StringSchema { c := s.clone(); c.enum = vals; return c }

// Refine adds a check returning a non-empty message on failure.
func (s *StringSchema) Refine(fn func(string) string) *StringSchema {
	c := s.clone()
	c.refines = append(c.refines, fn)
	return c
}

// HTTPSURL mirrors z.url({protocol: /^https$/}).
func (s *StringSchema) HTTPSURL() *StringSchema { c := s.clone(); c.httpsURL = true; return c }

// UTF16Len is the JavaScript string length of s.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
		if utf16.RuneLen(r) < 0 { // invalid rune → replacement char, 1 unit
			n += 2
		}
	}
	return n
}

func (s *StringSchema) check(v any, p string, is *issues) any {
	str, ok := v.(string)
	if !ok {
		is.add(p, "expected string")
		return nil
	}
	l := UTF16Len(str)
	if s.min >= 0 && l < s.min {
		is.add(p, "must contain at least %d character(s)", s.min)
	}
	if s.max >= 0 && l > s.max {
		is.add(p, "must contain at most %d character(s)", s.max)
	}
	if len(s.enum) > 0 {
		found := false
		for _, e := range s.enum {
			if e == str {
				found = true
				break
			}
		}
		if !found {
			is.add(p, "must be one of %s", strings.Join(s.enum, ", "))
		}
	}
	for _, re := range s.patterns {
		if !re.MatchString(str) {
			is.add(p, "invalid format")
		}
	}
	if len(s.anyOf) > 0 {
		match := false
		for _, re := range s.anyOf {
			if re.MatchString(str) {
				match = true
				break
			}
		}
		if !match {
			is.add(p, "invalid format")
		}
	}
	for _, fn := range s.refines {
		if msg := fn(str); msg != "" {
			is.add(p, "%s", msg)
		}
	}
	if s.httpsURL {
		if msg := checkHTTPSURL(str); msg != "" {
			is.add(p, "%s", msg)
		}
	}
	return str
}

func checkHTTPSURL(s string) string {
	if s != strings.TrimSpace(s) || strings.ContainsAny(s, "\t\r\n ") {
		return "invalid URL"
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "invalid URL"
	}
	if u.Scheme != "https" {
		return "URL protocol must be https"
	}
	return ""
}

// --- number ------------------------------------------------------------------------------

const maxSafeInteger = 1<<53 - 1

// NumberSchema validates JSON numbers (decoded with UseNumber).
type NumberSchema struct {
	integer  bool
	min, max *float64
}

// Num builds a float schema; Int a safe-integer schema.
func Num() *NumberSchema { return &NumberSchema{} }
func Int() *NumberSchema { return &NumberSchema{integer: true} }

func (n *NumberSchema) Min(v float64) *NumberSchema { c := *n; c.min = &v; return &c }
func (n *NumberSchema) Max(v float64) *NumberSchema { c := *n; c.max = &v; return &c }

func (n *NumberSchema) check(v any, p string, is *issues) any {
	num, ok := v.(json.Number)
	if !ok {
		is.add(p, "expected number")
		return nil
	}
	f, err := strconv.ParseFloat(string(num), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		is.add(p, "expected number")
		return nil
	}
	if n.integer && (math.Trunc(f) != f || math.Abs(f) > maxSafeInteger) {
		is.add(p, "expected integer")
		return nil
	}
	if n.min != nil && f < *n.min {
		is.add(p, "must be >= %v", *n.min)
	}
	if n.max != nil && f > *n.max {
		is.add(p, "must be <= %v", *n.max)
	}
	if n.integer {
		return int64(f)
	}
	return f
}

// --- bool / array / record ---------------------------------------------------------------

type boolSchema struct{}

// Bool builds a boolean schema.
func Bool() Schema { return boolSchema{} }

func (boolSchema) check(v any, p string, is *issues) any {
	b, ok := v.(bool)
	if !ok {
		is.add(p, "expected boolean")
		return nil
	}
	return b
}

// ArraySchema validates arrays.
type ArraySchema struct {
	item     Schema
	min, max int
	// unique is the message of a `.refine(isUniqueArray, msg)` (empty = no uniqueness check).
	unique string
}

// Arr builds an array schema; min/max of -1 means unbounded.
func Arr(item Schema, min, max int) *ArraySchema { return &ArraySchema{item: item, min: min, max: max} }

// Unique mirrors `.refine(isUniqueArray, msg)` in common.ts (strict equality of scalar items; runs
// only when the elements themselves are valid, like a zod refinement).
func (a *ArraySchema) Unique(msg string) *ArraySchema { c := *a; c.unique = msg; return &c }

func (a *ArraySchema) check(v any, p string, is *issues) any {
	arr, ok := v.([]any)
	if !ok {
		is.add(p, "expected array")
		return nil
	}
	before := len(is.list)
	if a.min >= 0 && len(arr) < a.min {
		is.add(p, "must contain at least %d element(s)", a.min)
	}
	if a.max >= 0 && len(arr) > a.max {
		is.add(p, "must contain at most %d element(s)", a.max)
	}
	out := make([]any, len(arr))
	for i, el := range arr {
		out[i] = a.item.check(el, fmt.Sprintf("%s[%d]", p, i), is)
	}
	if a.unique != "" && len(is.list) == before {
		seen := make(map[any]struct{}, len(out))
		for _, el := range out {
			switch el.(type) {
			case string, int64, float64, bool, nil:
			default:
				continue // objects/arrays are never equal under ===
			}
			if _, dup := seen[el]; dup {
				is.add(p, "%s", a.unique)
				break
			}
			seen[el] = struct{}{}
		}
	}
	return out
}

type recordSchema struct {
	key *StringSchema
	val Schema
}

// Record builds a z.record(key, value) schema.
func Record(key *StringSchema, val Schema) Schema { return recordSchema{key, val} }

func (r recordSchema) check(v any, p string, is *issues) any {
	m, ok := v.(map[string]any)
	if !ok {
		is.add(p, "expected object")
		return nil
	}
	out := make(map[string]any, len(m))
	for k, val := range m {
		r.key.check(k, joinPath(p, k)+"(key)", is)
		out[k] = r.val.check(val, joinPath(p, k), is)
	}
	return out
}

// --- entry points ------------------------------------------------------------------------

// DecodeJSONValue decodes raw JSON into generic values with json.Number for numbers.
func DecodeJSONValue(raw []byte) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data after JSON value")
	}
	return v, nil
}

// Validate checks raw JSON against s and decodes the cleaned value into out.
func Validate(s Schema, raw []byte, out any) *Error {
	v, err := DecodeJSONValue(raw)
	if err != nil {
		return Errorf(CodeValidationFailed, "payload is not valid JSON")
	}
	is := &issues{}
	cleaned := s.check(v, "", is)
	if len(is.list) > 0 {
		msg := "invalid payload"
		first := is.list[0]
		if first.Path != "" {
			msg = fmt.Sprintf("invalid payload: %s: %s", first.Path, first.Message)
		} else {
			msg = fmt.Sprintf("invalid payload: %s", first.Message)
		}
		return Errorf(CodeValidationFailed, "%s", msg).WithDetails(map[string]any{"issues": is.list})
	}
	b, err := json.Marshal(cleaned)
	if err != nil {
		return Errorf(CodeInternal, "re-encode payload: %v", err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return Errorf(CodeValidationFailed, "payload shape: %v", err)
	}
	return nil
}

// --- discriminated union ------------------------------------------------------------------

type unionSchema struct {
	key      string
	variants map[string]*ObjectSchema
}

// Union is z.discriminatedUnion(key, variants): the value of `key` selects the object schema.
func Union(key string, variants map[string]*ObjectSchema) Schema {
	return unionSchema{key: key, variants: variants}
}

func (u unionSchema) check(v any, p string, is *issues) any {
	m, ok := v.(map[string]any)
	if !ok {
		is.add(p, "expected object")
		return nil
	}
	tag, _ := m[u.key].(string)
	variant, ok := u.variants[tag]
	if !ok {
		is.add(joinPath(p, u.key), "invalid discriminator")
		return nil
	}
	return variant.check(v, p, is)
}

// --- refinement ---------------------------------------------------------------------------

type refineSchema struct {
	inner Schema
	fn    func(v any) (path, msg string)
}

// RefineObj runs fn on the cleaned value (with defaults) after inner validation succeeded.
func RefineObj(inner Schema, fn func(v any) (path, msg string)) Schema {
	return refineSchema{inner, fn}
}

func (r refineSchema) check(v any, p string, is *issues) any {
	before := len(is.list)
	out := r.inner.check(v, p, is)
	if len(is.list) == before {
		if fp, msg := r.fn(out); msg != "" {
			is.add(joinPath(p, fp), "%s", msg)
		}
	}
	return out
}
