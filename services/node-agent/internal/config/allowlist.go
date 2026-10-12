package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// ImageRef is a normalised image reference.
type ImageRef struct {
	Repo   string // e.g. docker.io/library/eclipse-temurin
	Tag    string // "" if absent
	Digest string // "sha256:…" or ""
}

// String renders the normalised reference.
func (r ImageRef) String() string {
	s := r.Repo
	if r.Tag != "" {
		s += ":" + r.Tag
	}
	if r.Digest != "" {
		s += "@" + r.Digest
	}
	return s
}

var (
	reRepoComponent = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$`)
	reRegistryHost  = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$`)
	reTag           = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
	reDigest        = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// ParseImageRef normalises Docker Hub short names (eclipse-temurin ≡ docker.io/library/eclipse-temurin).
// Registries with ports are rejected (unsupported in v1).
func ParseImageRef(s string) (ImageRef, error) {
	var ref ImageRef
	if s == "" || len(s) > 255 {
		return ref, errors.New("invalid image reference")
	}
	name := s
	if at := strings.Index(name, "@"); at >= 0 {
		ref.Digest = name[at+1:]
		name = name[:at]
		if !reDigest.MatchString(ref.Digest) {
			return ref, errors.New("invalid image digest")
		}
	}
	// A tag is the part after the last ':' that follows the last '/'.
	if c := strings.LastIndex(name, ":"); c > strings.LastIndex(name, "/") {
		ref.Tag = name[c+1:]
		name = name[:c]
		if !reTag.MatchString(ref.Tag) {
			return ref, errors.New("invalid image tag")
		}
	}
	parts := strings.Split(name, "/")
	registry := "docker.io"
	if len(parts) > 1 && (strings.ContainsAny(parts[0], ".:") || parts[0] == "localhost") {
		registry = parts[0]
		parts = parts[1:]
		if strings.Contains(registry, ":") {
			return ref, errors.New("image registries with ports are not supported")
		}
		if !reRegistryHost.MatchString(registry) {
			return ref, errors.New("invalid image registry")
		}
		registry = strings.ToLower(registry)
	}
	if registry == "index.docker.io" {
		registry = "docker.io"
	}
	if len(parts) == 0 {
		return ref, errors.New("invalid image reference")
	}
	for _, p := range parts {
		if !reRepoComponent.MatchString(p) {
			return ref, fmt.Errorf("invalid image name component %q", p)
		}
	}
	if registry == "docker.io" && len(parts) == 1 {
		parts = append([]string{"library"}, parts...)
	}
	ref.Repo = registry + "/" + strings.Join(parts, "/")
	return ref, nil
}

type imageRule struct {
	anyTag bool
	ref    ImageRef
}

// ImageAllowlist authorises workload images (agent-protocol.md §6).
type ImageAllowlist struct{ rules []imageRule }

// NewImageAllowlist parses entries: `repo:*` (any tag, never digest refs) or an exact reference.
func NewImageAllowlist(entries []string) (*ImageAllowlist, error) {
	al := &ImageAllowlist{}
	for _, e := range entries {
		e = strings.TrimSpace(e)
		rule := imageRule{}
		if strings.HasSuffix(e, ":*") {
			rule.anyTag = true
			e = strings.TrimSuffix(e, ":*")
		}
		if strings.Contains(e, "*") {
			return nil, fmt.Errorf("image allowlist entry %q: only a trailing ':*' wildcard is supported", e)
		}
		ref, err := ParseImageRef(e)
		if err != nil {
			return nil, fmt.Errorf("image allowlist entry %q: %w", e, err)
		}
		if rule.anyTag && (ref.Tag != "" || ref.Digest != "") {
			return nil, fmt.Errorf("image allowlist entry %q: ':*' must follow a bare repository", e)
		}
		rule.ref = ref
		al.rules = append(al.rules, rule)
	}
	return al, nil
}

// Allowed reports whether image may be used. Exact entries compare the full normalised reference.
func (al *ImageAllowlist) Allowed(image string) bool {
	ref, err := ParseImageRef(image)
	if err != nil {
		return false
	}
	for _, r := range al.rules {
		if r.anyTag {
			if ref.Repo == r.ref.Repo && ref.Tag != "" && ref.Digest == "" {
				return true
			}
			continue
		}
		if ref == r.ref {
			return true
		}
	}
	return false
}

// HostAllowlist restricts artifact downloads (initial URL and every redirect).
type HostAllowlist struct {
	entries []hostEntry
}

type hostEntry struct {
	host     string // lower-case; may start with "*." for subdomains
	port     string // "" = default https port only
	wildcard bool
}

// NewHostAllowlist parses entries `host`, `host:port` or `*.domain`.
func NewHostAllowlist(entries []string) *HostAllowlist {
	al := &HostAllowlist{}
	for _, e := range entries {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		he := hostEntry{}
		if h, p, err := net.SplitHostPort(e); err == nil {
			he.host, he.port = h, p
		} else {
			he.host = e
		}
		if strings.HasPrefix(he.host, "*.") {
			he.wildcard = true
			he.host = he.host[1:] // ".domain"
		}
		al.entries = append(al.entries, he)
	}
	return al
}

// Allowed checks scheme (https only), absence of credentials, and host/port membership.
func (al *HostAllowlist) Allowed(u *url.URL) error {
	if u.Scheme != "https" {
		return fmt.Errorf("only https downloads are allowed (got %q)", u.Scheme)
	}
	if u.User != nil {
		return errors.New("download URLs must not contain credentials")
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	for _, e := range al.entries {
		hostOK := (!e.wildcard && host == e.host) || (e.wildcard && strings.HasSuffix(host, e.host) && len(host) > len(e.host))
		if !hostOK {
			continue
		}
		if e.port == "" && (port == "" || port == "443") {
			return nil
		}
		if e.port != "" && port == e.port {
			return nil
		}
	}
	return fmt.Errorf("host %q is not on the agent download allowlist", u.Host)
}
