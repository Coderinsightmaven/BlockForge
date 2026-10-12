package fsops

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Matcher decides whether a sandbox-relative path is protected (template fileDenylist).
type Matcher interface {
	Active() bool
	Denied(rel string) bool
}

// maxLinkHops bounds symlink resolution (Linux uses 40 as well).
const maxLinkHops = 40

// WithDenylist returns a view of the root that enforces m on every read and mutation: a path is
// refused if the requested path, any symlink it passes through, or its resolved location inside the
// sandbox is denied; directory operations (recursive delete, rename, copy, compress) also refuse
// if any entry below them is denied. Listings (fs.list/stat/find/du) are not filtered.
func (r *Root) WithDenylist(m Matcher) *Root {
	c := *r
	if m != nil && m.Active() {
		c.deny = m
	} else {
		c.deny = nil
	}
	return &c
}

func denyErr(p string) error {
	return protocol.Errorf(protocol.CodePathForbidden, "%q is protected by the server template", p).
		WithDetails(map[string]any{"reason": "denylist"})
}

// resolve follows symlinks inside the root and returns the resolved clean path ("." = root) and
// every symlink location passed. Missing trailing components are kept as-is (paths to be created).
// Absolute symlinks or links climbing above the root are refused (os.Root refuses them too).
func (r *Root) resolve(clean string) (string, []string, error) {
	if clean == "." || clean == "" {
		return ".", nil, nil
	}
	queue := strings.Split(clean, "/")
	var cur []string
	var visited []string
	hops := 0
	for i := 0; i < len(queue); i++ {
		seg := queue[i]
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			if len(cur) == 0 {
				return "", visited, protocol.Errorf(protocol.CodePathForbidden, "path escapes the workload data root")
			}
			cur = cur[:len(cur)-1]
			continue
		}
		cand := path.Join(append(append([]string{}, cur...), seg)...)
		fi, err := r.r.Lstat(cand)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return path.Join(append([]string{cand}, queue[i+1:]...)...), visited, nil
			}
			return "", visited, MapError("resolve", cand, err)
		}
		if fi.Mode()&fs.ModeSymlink == 0 {
			cur = append(cur, seg)
			continue
		}
		hops++
		if hops > maxLinkHops {
			return "", visited, protocol.Errorf(protocol.CodePathForbidden, "too many symbolic links")
		}
		visited = append(visited, cand)
		target, err := r.r.Readlink(cand)
		if err != nil {
			return "", visited, MapError("resolve", cand, err)
		}
		target = filepath.ToSlash(target)
		if strings.HasPrefix(target, "/") || (len(target) > 1 && target[1] == ':') {
			return "", visited, protocol.Errorf(protocol.CodePathForbidden, "absolute symlink")
		}
		// Re-resolve the link target relative to its directory, then the remaining components.
		next := append(append([]string{}, cur...), strings.Split(target, "/")...)
		queue = append(next, queue[i+1:]...)
		cur = nil
		i = -1
	}
	if len(cur) == 0 {
		return ".", visited, nil
	}
	return path.Join(cur...), visited, nil
}

// checkDeny refuses clean if it or its resolution is denied. It returns the resolved path.
func (r *Root) checkDeny(clean string) (string, error) {
	if r.deny == nil {
		return clean, nil
	}
	if r.deny.Denied(clean) {
		return "", denyErr(displayPath(clean))
	}
	resolved, visited, err := r.resolve(clean)
	if err != nil {
		return "", err
	}
	for _, v := range visited {
		if r.deny.Denied(v) {
			return "", denyErr(displayPath(clean))
		}
	}
	if r.deny.Denied(resolved) {
		return "", denyErr(displayPath(clean))
	}
	return resolved, nil
}

// checkDenyTree is checkDeny plus every entry below a directory (symlinks are not descended, the
// same way copy/compress/delete treat them), in both requested and resolved coordinates.
func (r *Root) checkDenyTree(clean string) error {
	resolved, err := r.checkDeny(clean)
	if err != nil || r.deny == nil {
		return err
	}
	fi, err := r.r.Lstat(resolved)
	if err != nil || !fi.IsDir() {
		return nil
	}
	seen := 0
	walkErr := fs.WalkDir(r.r.FS(), resolved, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		seen++
		if seen > MaxWalkEntries {
			return protocol.Errorf(protocol.CodeQuotaExceeded, "directory has more than %d entries", MaxWalkEntries)
		}
		suffix := strings.TrimPrefix(fp, resolved)
		if resolved == "." {
			suffix = "/" + fp
		}
		req := strings.TrimPrefix(path.Join(clean, suffix), "./")
		if r.deny.Denied(fp) || r.deny.Denied(req) {
			return denyErr(displayPath(req))
		}
		return nil
	})
	return walkErr
}

// CheckDenied exposes checkDeny for the SFTP server (requested path already clean).
func (r *Root) CheckDenied(clean string) error {
	_, err := r.checkDeny(clean)
	return err
}

// CheckDeniedTree exposes checkDenyTree for the SFTP server.
func (r *Root) CheckDeniedTree(clean string) error { return r.checkDenyTree(clean) }

// VerifyOpen re-checks an opened file against the denylist using its real location (Linux:
// /proc/self/fd), which closes the window between resolving a path and opening it (a workload
// swapping a symlink in between). On other platforms the pre-open check is the only check.
func (r *Root) VerifyOpen(f *os.File, requested string) error {
	if r.deny == nil {
		return nil
	}
	rel, ok := r.realRel(f)
	if !ok {
		return nil
	}
	if r.deny.Denied(rel) {
		return denyErr(displayPath(requested))
	}
	return nil
}

// OpenForRead opens a regular file with denylist enforcement (pre-check + post-open verification).
func (r *Root) OpenForRead(name string) (*os.File, fs.FileInfo, error) {
	if _, err := r.checkDeny(name); err != nil {
		return nil, nil, err
	}
	f, fi, err := r.OpenRegular(name)
	if err != nil {
		return nil, nil, err
	}
	if err := r.VerifyOpen(f, name); err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// realDataDir is the symlink-free host path of the sandbox (for /proc/self/fd comparisons).
func (r *Root) realDataDir() string {
	r.info.once.Do(func() {
		if p, err := filepath.EvalSymlinks(r.info.dir); err == nil {
			r.info.real = p
		}
	})
	return r.info.real
}
