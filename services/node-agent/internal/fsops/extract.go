package fsops

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"

	"github.com/blockforge/node-agent/internal/protocol"
)

// ExtractResult is the fs.extract result.
type ExtractResult struct {
	Entries int64 `json:"entries"`
	Bytes   int64 `json:"bytes"`
	// Files counts regular files written (not on the fs.extract wire format).
	Files int64 `json:"-"`
}

type archiveKind int

const (
	kindZip archiveKind = iota + 1
	kindTar
	kindTarGz
)

func detectArchive(f *os.File) (archiveKind, error) {
	var hdr [512]byte
	n, err := io.ReadFull(f, hdr[:])
	if _, serr := f.Seek(0, io.SeekStart); serr != nil {
		return 0, serr
	}
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return 0, err
	}
	b := hdr[:n]
	switch {
	case len(b) >= 4 && string(b[:4]) == "PK\x03\x04", len(b) >= 4 && string(b[:4]) == "PK\x05\x06":
		return kindZip, nil
	case len(b) >= 2 && b[0] == 0x1f && b[1] == 0x8b:
		return kindTarGz, nil
	case len(b) >= 262 && string(b[257:262]) == "ustar":
		return kindTar, nil
	}
	return 0, protocol.Errorf(protocol.CodeValidationFailed, "unsupported archive format (zip, tar and tar.gz are supported)")
}

// archiveEntryName validates an entry name; ok=false (no error) means "skip" (the root entry).
func archiveEntryName(name string) (string, bool, error) {
	if name == "" {
		return "", false, protocol.Errorf(protocol.CodePathForbidden, "archive entry with empty name")
	}
	clean, err := CleanPath(name, false)
	if err != nil {
		var pe *protocol.Error
		if errors.As(err, &pe) {
			return "", false, protocol.Errorf(protocol.CodePathForbidden, "archive entry %q rejected: %s", truncateName(name), pe.Message)
		}
		return "", false, err
	}
	if clean == "." {
		return "", false, nil
	}
	return clean, true, nil
}

func truncateName(s string) string {
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

type plannedEntry struct {
	name string
	dir  bool
}

// Extract implements fs.extract. Pass 1 validates every entry name/type and the declared sizes
// against the limits without writing anything (symlinks, hardlinks, devices, FIFOs, absolute
// paths and '..' reject the whole archive). Pass 2 extracts, counting the bytes actually
// decompressed; if the limit is hit anyway, files created by this extraction are removed.
func (r *Root) Extract(p protocol.FsExtractPayload) (*ExtractResult, error) {
	archive, err := CleanPath(p.ArchivePath, true)
	if err != nil {
		return nil, err
	}
	dest, err := CleanPath(p.DestPath, false)
	if err != nil {
		return nil, err
	}
	// Resolve the destination first so an escaping destination is refused before anything else.
	if _, err := r.r.Stat(dest); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, MapError("extract", p.DestPath, err)
	}
	if _, err := r.checkDeny(dest); err != nil {
		return nil, err
	}
	f, fi, err := r.OpenForRead(archive)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return r.ExtractFrom(f, fi.Size(), dest, ArchiveOptions{MaxTotalBytes: p.MaxTotalBytes, MaxEntries: p.MaxEntries})
}

// ArchiveOptions tune ExtractFrom.
type ArchiveOptions struct {
	MaxTotalBytes int64
	MaxEntries    int64
	// KeepPerms applies the archive's permission bits (masked to 0777; never setuid/setgid/sticky)
	// to regular files instead of 0644. Used for backups the agent wrote itself.
	KeepPerms bool
	// BeforeWrite runs after the whole archive has been validated and before anything is written
	// (backup restore truncates the data dir here).
	BeforeWrite func() error
	// Progress is told about extracted entries and bytes.
	Progress func(entries, bytes int64)
}

// ExtractFrom extracts an archive that may live outside the sandbox (a backup) into dest (clean,
// sandbox-relative) with the fs.extract safety rules: validation first, no links/devices/escapes,
// entry and byte limits counted on decompressed data, denylist (if set) on every entry path.
func (r *Root) ExtractFrom(f *os.File, size int64, dest string, o ArchiveOptions) (*ExtractResult, error) {
	kind, err := detectArchive(f)
	if err != nil {
		return nil, err
	}
	ex := &extractor{r: r, dest: dest, maxBytes: o.MaxTotalBytes, maxEntries: o.MaxEntries, keepPerms: o.KeepPerms, progress: o.Progress}
	begin := func() error {
		if o.BeforeWrite != nil {
			if err := o.BeforeWrite(); err != nil {
				return err
			}
		}
		return r.MkdirAll(dest)
	}
	switch kind {
	case kindZip:
		zr, err := zip.NewReader(f, size)
		if err != nil {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid zip archive")
		}
		if err := ex.planZip(zr); err != nil {
			return nil, err
		}
		if err := begin(); err != nil {
			return nil, err
		}
		if err := ex.extractZip(zr); err != nil {
			ex.cleanup()
			return nil, err
		}
	case kindTar, kindTarGz:
		open := func() (io.Reader, func(), error) {
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				return nil, nil, err
			}
			if kind == kindTar {
				return bufio.NewReader(f), func() {}, nil
			}
			gz, err := gzip.NewReader(bufio.NewReader(f))
			if err != nil {
				return nil, nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid gzip stream")
			}
			return gz, func() { gz.Close() }, nil
		}
		rd, closeFn, err := open()
		if err != nil {
			return nil, err
		}
		err = ex.planTar(tar.NewReader(rd))
		closeFn()
		if err != nil {
			return nil, err
		}
		if err := begin(); err != nil {
			return nil, err
		}
		rd, closeFn, err = open()
		if err != nil {
			return nil, err
		}
		err = ex.extractTar(tar.NewReader(rd))
		closeFn()
		if err != nil {
			ex.cleanup()
			return nil, err
		}
	}
	return &ExtractResult{Entries: ex.entries, Bytes: ex.written, Files: ex.files}, nil
}

type extractor struct {
	r          *Root
	dest       string
	maxBytes   int64
	maxEntries int64
	entries    int64
	written    int64
	created    []string
	keepPerms  bool
	files      int64
	progress   func(entries, bytes int64)
}

// fileMode is 0644, or the archive's permission bits when keepPerms is set.
func (ex *extractor) fileMode(m fs.FileMode) fs.FileMode {
	if ex.keepPerms {
		return m.Perm()
	}
	return 0o644
}

func (ex *extractor) quota(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeQuotaExceeded, format, args...)
}

func (ex *extractor) planZip(zr *zip.Reader) error {
	var declared uint64
	if int64(len(zr.File)) > ex.maxEntries {
		return ex.quota("archive has %d entries (limit %d)", len(zr.File), ex.maxEntries)
	}
	for _, zf := range zr.File {
		name, ok, err := archiveEntryName(zf.Name)
		if err != nil {
			return err
		}
		if err := ex.checkEntryDeny(name, ok); err != nil {
			return err
		}
		m := zf.Mode()
		if m&fs.ModeSymlink != 0 {
			return protocol.Errorf(protocol.CodePathForbidden, "archive contains a symlink (%q)", truncateName(zf.Name))
		}
		if !m.IsDir() && !m.IsRegular() {
			return protocol.Errorf(protocol.CodePathForbidden, "archive contains a special file (%q)", truncateName(zf.Name))
		}
		declared += zf.UncompressedSize64
		if declared > uint64(ex.maxBytes) {
			return ex.quota("archive expands to more than %d bytes", ex.maxBytes)
		}
	}
	return nil
}

func (ex *extractor) extractZip(zr *zip.Reader) error {
	for _, zf := range zr.File {
		name, ok, err := archiveEntryName(zf.Name)
		if err != nil {
			return err
		}
		ex.entries++
		if ex.entries > ex.maxEntries {
			return ex.quota("archive has more than %d entries", ex.maxEntries)
		}
		if !ok {
			continue
		}
		target := path.Join(ex.dest, name)
		if zf.Mode().IsDir() {
			if err := ex.r.MkdirAll(target); err != nil {
				return err
			}
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return protocol.Errorf(protocol.CodeValidationFailed, "zip entry %q: %v", truncateName(zf.Name), err)
		}
		err = ex.writeFile(target, rc, ex.fileMode(zf.Mode()))
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func tarTypeOK(h *tar.Header) error {
	switch h.Typeflag {
	case tar.TypeReg, tar.TypeRegA, tar.TypeDir:
		return nil
	case tar.TypeSymlink:
		return protocol.Errorf(protocol.CodePathForbidden, "archive contains a symlink (%q)", truncateName(h.Name))
	case tar.TypeLink:
		return protocol.Errorf(protocol.CodePathForbidden, "archive contains a hardlink (%q)", truncateName(h.Name))
	case tar.TypeChar, tar.TypeBlock:
		return protocol.Errorf(protocol.CodePathForbidden, "archive contains a device node (%q)", truncateName(h.Name))
	case tar.TypeFifo:
		return protocol.Errorf(protocol.CodePathForbidden, "archive contains a FIFO (%q)", truncateName(h.Name))
	}
	return protocol.Errorf(protocol.CodePathForbidden, "archive entry %q has unsupported type %q", truncateName(h.Name), string(h.Typeflag))
}

func (ex *extractor) planTar(tr *tar.Reader) error {
	var entries, declared int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return protocol.Errorf(protocol.CodeValidationFailed, "invalid tar archive")
		}
		entries++
		if entries > ex.maxEntries {
			return ex.quota("archive has more than %d entries", ex.maxEntries)
		}
		name, ok, err := archiveEntryName(h.Name)
		if err != nil {
			return err
		}
		if err := tarTypeOK(h); err != nil {
			return err
		}
		if err := ex.checkEntryDeny(name, ok); err != nil {
			return err
		}
		if h.Size < 0 {
			return protocol.Errorf(protocol.CodeValidationFailed, "invalid tar entry size")
		}
		declared += h.Size
		if declared > ex.maxBytes {
			// Stop before decompressing further: a gzip bomb never gets past this point.
			return ex.quota("archive expands to more than %d bytes", ex.maxBytes)
		}
	}
}

func (ex *extractor) extractTar(tr *tar.Reader) error {
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return protocol.Errorf(protocol.CodeValidationFailed, "invalid tar archive")
		}
		ex.entries++
		if ex.entries > ex.maxEntries {
			return ex.quota("archive has more than %d entries", ex.maxEntries)
		}
		if err := tarTypeOK(h); err != nil {
			return err
		}
		name, ok, err := archiveEntryName(h.Name)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		target := path.Join(ex.dest, name)
		if h.Typeflag == tar.TypeDir {
			if err := ex.r.MkdirAll(target); err != nil {
				return err
			}
			continue
		}
		if err := ex.writeFile(target, tr, ex.fileMode(fs.FileMode(h.Mode))); err != nil {
			return err
		}
	}
}

// writeFile copies at most the remaining byte budget (+1 to detect overflow) into target.
func (ex *extractor) writeFile(target string, src io.Reader, mode fs.FileMode) error {
	if err := ex.r.MkdirAll(path.Dir(target)); err != nil {
		return err
	}
	existed := false
	if fi, err := ex.r.r.Lstat(target); err == nil {
		existed = true
		if fi.IsDir() {
			return protocol.Errorf(protocol.CodeConflict, "archive file %q collides with a directory", target)
		}
	}
	tf, err := ex.r.CreateTemp(target, mode)
	if err != nil {
		return err
	}
	remaining := ex.maxBytes - ex.written
	n, err := io.Copy(tf, io.LimitReader(src, remaining+1))
	if err != nil {
		tf.Abort()
		if pe, ok := protocol.AsError(err); ok {
			return pe
		}
		return protocol.Errorf(protocol.CodeValidationFailed, "archive entry %q: corrupt data", truncateName(target))
	}
	if n > remaining {
		tf.Abort()
		return ex.quota("archive expands to more than %d bytes", ex.maxBytes)
	}
	if _, _, err := tf.Commit(); err != nil {
		return err
	}
	ex.written += n
	ex.files++
	if !existed {
		ex.created = append(ex.created, target)
	}
	if ex.progress != nil {
		ex.progress(ex.entries, ex.written)
	}
	return nil
}

// cleanup removes files created by a failed extraction (best effort; overwritten files stay replaced).
func (ex *extractor) cleanup() {
	for i := len(ex.created) - 1; i >= 0; i-- {
		_ = ex.r.r.Remove(ex.created[i])
	}
}

// checkEntryDeny refuses archives that would write a denied path (resolved through existing
// symlinks in the destination, like the extraction itself would).
func (ex *extractor) checkEntryDeny(name string, ok bool) error {
	if !ok || ex.r.deny == nil {
		return nil
	}
	_, err := ex.r.checkDeny(path.Join(ex.dest, name))
	return err
}
