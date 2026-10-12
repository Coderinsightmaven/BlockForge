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
	kind, err := detectArchive(f)
	if err != nil {
		return nil, err
	}
	if err := r.MkdirAll(dest); err != nil {
		return nil, err
	}
	ex := &extractor{r: r, dest: dest, maxBytes: p.MaxTotalBytes, maxEntries: p.MaxEntries}
	switch kind {
	case kindZip:
		zr, err := zip.NewReader(f, fi.Size())
		if err != nil {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid zip archive")
		}
		if err := ex.planZip(zr); err != nil {
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
	return &ExtractResult{Entries: ex.entries, Bytes: ex.written}, nil
}

type extractor struct {
	r          *Root
	dest       string
	maxBytes   int64
	maxEntries int64
	entries    int64
	written    int64
	created    []string
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
		err = ex.writeFile(target, rc)
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
		if err := ex.writeFile(target, tr); err != nil {
			return err
		}
	}
}

// writeFile copies at most the remaining byte budget (+1 to detect overflow) into target.
func (ex *extractor) writeFile(target string, src io.Reader) error {
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
	tf, err := ex.r.CreateTemp(target, 0o644)
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
	if !existed {
		ex.created = append(ex.created, target)
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
