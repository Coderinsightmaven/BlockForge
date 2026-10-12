// Package jarread reads selected entries of zip/jar files without extracting anything
// (jar.readEntries, agent-protocol.md §6). Nothing is allocated from header-declared sizes and every
// read is bounded:
//
//   - The end-of-central-directory record is searched in the last 64 KiB + 22 bytes, the way
//     java.util.zip.ZipFile does (the central directory is authoritative, as for the loaders); Zip64
//     end records are used when consistent with the 32-bit record, as Java does.
//   - The central directory is streamed (never loaded): at most MaxRecords records and MaxCDBytes
//     bytes, every record must lie inside the declared directory and the records must fill it exactly.
//     Only records whose name equals a requested name are kept (exact, case-sensitive byte comparison).
//   - A requested entry is read through its local header, whose name must equal the central
//     directory's; its data must end before the central directory. Only stored and deflate are
//     supported; encrypted entries are refused. Decompression stops after maxBytes (+1 probe byte),
//     so a zip bomb costs at most that much output; data descriptors are irrelevant because the sizes
//     and CRC come from the central directory. A fully read entry must match the declared size and
//     CRC-32; a partially read one must not exceed its declared size.
package jarread

import (
	"bufio"
	"compress/flate"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Errors returned by Read (test with errors.Is; they carry a short reason).
var (
	// ErrNotZip: no valid central directory, malformed or encrypted data, an unsupported compression
	// method or a size/CRC mismatch in a requested entry.
	ErrNotZip = errors.New("not a zip")
	// ErrTooLarge: the central directory exceeds Limits.
	ErrTooLarge = errors.New("central directory too large")
	// ErrAmbiguous: a requested name occurs more than once in the central directory.
	ErrAmbiguous = errors.New("ambiguous entry")
)

// IOError is a failure to read the underlying file (it shrank while being read, or the device failed).
type IOError struct{ Err error }

func (e *IOError) Error() string { return "read: " + e.Err.Error() }
func (e *IOError) Unwrap() error { return e.Err }

// Limits bound the central directory (JAR_READ_LIMITS).
type Limits struct {
	MaxRecords int
	MaxCDBytes int64
}

// DefaultLimits are the contract's JAR_READ_LIMITS.
var DefaultLimits = Limits{MaxRecords: protocol.JarMaxCentralDirectoryRecords, MaxCDBytes: protocol.JarMaxCentralDirectoryBytes}

// Entry is a requested entry that exists.
type Entry struct {
	Name string
	// Data is the decompressed prefix of the entry (at most maxBytes).
	Data []byte
	// Complete: Data is the whole entry and matched the declared size and CRC-32.
	Complete bool
	// Size is the uncompressed size declared by the central directory (untrusted).
	Size uint64
}

// Result lists the requested entries that exist (request order) and the names that do not.
type Result struct {
	Entries []Entry
	Missing []string
}

const (
	eocdLen      = 22
	eocdSig      = 0x06054b50
	zip64LocLen  = 20
	zip64LocSig  = 0x07064b50
	zip64EndLen  = 56
	zip64EndSig  = 0x06064b50
	cdHeaderLen  = 46
	cdSig        = 0x02014b50
	localLen     = 30
	localSig     = 0x04034b50
	maxComment   = 0xFFFF
	magic32      = 0xFFFFFFFF
	magic16      = 0xFFFF
	zip64ExtraID = 0x0001

	flagEncrypted       = 0x0001
	flagStrongEncrypted = 0x0040
	methodStored        = 0
	methodDeflated      = 8

	maxSafeInteger = 1<<53 - 1
)

func le16(b []byte) uint64 { return uint64(binary.LittleEndian.Uint16(b)) }
func le32(b []byte) uint64 { return uint64(binary.LittleEndian.Uint32(b)) }
func le64(b []byte) uint64 { return binary.LittleEndian.Uint64(b) }

func notZip(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrNotZip, fmt.Sprintf(format, args...))
}

// source is the file being read: every read is checked against the context and must return all
// requested bytes (all offsets are validated against size first, so a short read means the file
// changed: IOError).
type source struct {
	ctx  context.Context
	ra   io.ReaderAt
	size int64
}

// ReadAt implements io.ReaderAt for section readers over the file.
func (s *source) ReadAt(p []byte, off int64) (int, error) {
	if err := s.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := s.ra.ReadAt(p, off)
	if n < len(p) {
		if err == nil || err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return n, &IOError{Err: err}
	}
	return n, nil
}

// readAt reads exactly len(p) bytes at off, which the caller has checked to lie inside the file.
func (s *source) readAt(p []byte, off int64) error {
	if off < 0 || off > s.size || int64(len(p)) > s.size-off {
		return notZip("record outside the file")
	}
	_, err := s.ReadAt(p, off)
	return err
}

// classify keeps I/O and context errors and turns everything else (decoder errors, unexpected
// EOF of a section) into ErrNotZip.
func classify(err error, what string) error {
	var ioe *IOError
	switch {
	case errors.As(err, &ioe):
		return ioe
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	}
	return notZip("%s: %v", what, err)
}

// directory locates the central directory.
type directory struct {
	start int64 // absolute offset of the central directory
	size  int64 // its declared size
	base  int64 // added to local header offsets (data prefixed to the archive, as Java allows)
}

// end holds the (possibly Zip64) end-of-central-directory values.
type end struct {
	pos    int64  // offset of the end record the directory size is measured from
	total  uint64 // declared number of records
	cdSize uint64
	cdOff  uint64
}

// Read reads the requested entries (names: valid, unique entry names) of the zip in ra (size bytes).
func Read(ctx context.Context, ra io.ReaderAt, size int64, names []string, maxBytes int, lim Limits) (*Result, error) {
	s := &source{ctx: ctx, ra: ra, size: size}
	dir, err := s.findDirectory(lim)
	if err != nil {
		return nil, err
	}
	found, err := s.scan(dir, names, lim)
	if err != nil {
		return nil, err
	}
	res := &Result{Entries: []Entry{}, Missing: []string{}}
	for i, name := range names {
		e := found[i]
		if e == nil {
			res.Missing = append(res.Missing, name)
			continue
		}
		data, complete, err := s.readEntry(dir, e, name, maxBytes)
		if err != nil {
			return nil, err
		}
		res.Entries = append(res.Entries, Entry{Name: name, Data: data, Complete: complete, Size: e.usize})
	}
	return res, nil
}

// findDirectory searches the end record backwards like java.util.zip.ZipFile: the last signature
// whose comment reaches the end of the file exactly, or — with trailing bytes — whose central
// directory and first local header signatures are where it says.
func (s *source) findDirectory(lim Limits) (*directory, error) {
	if s.size < eocdLen {
		return nil, notZip("file too short")
	}
	tailLen := min(s.size, eocdLen+maxComment)
	tailOff := s.size - tailLen
	tail := make([]byte, tailLen)
	if err := s.readAt(tail, tailOff); err != nil {
		return nil, err
	}
	for i := int(tailLen) - eocdLen; i >= 0; i-- {
		if le32(tail[i:]) != eocdSig {
			continue
		}
		rec := tail[i : i+eocdLen]
		e := end{pos: tailOff + int64(i), total: le16(rec[10:]), cdSize: le32(rec[12:]), cdOff: le32(rec[16:])}
		if e.pos+eocdLen+int64(le16(rec[20:])) != s.size {
			ok, err := s.plausible(e)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
		}
		if err := s.zip64(&e); err != nil {
			return nil, err
		}
		return s.validate(e, lim)
	}
	return nil, notZip("no end of central directory record")
}

// plausible: the central directory and the first local header start with their signatures.
func (s *source) plausible(e end) (bool, error) {
	if e.cdSize > uint64(e.pos) || e.cdOff > uint64(e.pos)-e.cdSize {
		return false, nil
	}
	cdPos := e.pos - int64(e.cdSize)
	locPos := cdPos - int64(e.cdOff)
	var sig [4]byte
	for _, p := range []struct {
		off int64
		sig uint64
	}{{cdPos, cdSig}, {locPos, localSig}} {
		if p.off+4 > s.size {
			return false, nil
		}
		if err := s.readAt(sig[:], p.off); err != nil {
			return false, err
		}
		if le32(sig[:]) != p.sig {
			return false, nil
		}
	}
	return true, nil
}

// zip64 replaces e's values with the Zip64 end record's when a locator precedes the end record,
// the record is where the locator says and its values agree with the 32-bit ones (or those are
// the 0xFFFF/0xFFFFFFFF markers) — java.util.zip.ZipFile's rules.
func (s *source) zip64(e *end) error {
	if e.pos < zip64LocLen {
		return nil
	}
	var loc [zip64LocLen]byte
	if err := s.readAt(loc[:], e.pos-zip64LocLen); err != nil {
		return err
	}
	if le32(loc[:]) != zip64LocSig {
		return nil
	}
	recPos := le64(loc[8:])
	if recPos > uint64(s.size) || uint64(s.size)-recPos < zip64EndLen {
		return nil
	}
	var rec [zip64EndLen]byte
	if err := s.readAt(rec[:], int64(recPos)); err != nil {
		return err
	}
	if le32(rec[:]) != zip64EndSig {
		return nil
	}
	total, cdSize, cdOff := le64(rec[32:]), le64(rec[40:]), le64(rec[48:])
	if (cdSize != e.cdSize && e.cdSize != magic32) || (cdOff != e.cdOff && e.cdOff != magic32) ||
		(total != e.total && e.total != magic16) {
		return nil
	}
	e.pos, e.total, e.cdSize, e.cdOff = int64(recPos), total, cdSize, cdOff
	return nil
}

func (s *source) validate(e end, lim Limits) (*directory, error) {
	if e.total > uint64(lim.MaxRecords) {
		return nil, fmt.Errorf("%w: %d records declared (limit %d)", ErrTooLarge, e.total, lim.MaxRecords)
	}
	if e.cdSize > uint64(lim.MaxCDBytes) {
		return nil, fmt.Errorf("%w: %d bytes declared (limit %d)", ErrTooLarge, e.cdSize, lim.MaxCDBytes)
	}
	if e.cdSize > uint64(e.pos) {
		return nil, notZip("bad central directory size")
	}
	start := e.pos - int64(e.cdSize)
	if e.cdOff > uint64(start) {
		return nil, notZip("bad central directory offset")
	}
	return &directory{start: start, size: int64(e.cdSize), base: start - int64(e.cdOff)}, nil
}

// cdEntry is the central directory record of a requested entry.
type cdEntry struct {
	flags, method uint64
	crc           uint32
	csize, usize  uint64
	offset        uint64
}

// scan streams the central directory and keeps the records of the requested names.
func (s *source) scan(dir *directory, names []string, lim Limits) ([]*cdEntry, error) {
	want := make(map[string]int, len(names))
	maxName := 0
	for i, n := range names {
		want[n] = i
		maxName = max(maxName, len(n))
	}
	found := make([]*cdEntry, len(names))
	dup := make([]bool, len(names))
	br := bufio.NewReaderSize(io.NewSectionReader(s, dir.start, dir.size), 64<<10)
	nameBuf := make([]byte, maxName)
	var extraBuf []byte
	var hdr [cdHeaderLen]byte
	records := 0
	for pos := int64(0); pos < dir.size; {
		if dir.size-pos < cdHeaderLen {
			return nil, notZip("truncated central directory record")
		}
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return nil, classify(err, "central directory")
		}
		if le32(hdr[:]) != cdSig {
			return nil, notZip("bad central directory record signature")
		}
		records++
		if records > lim.MaxRecords {
			return nil, fmt.Errorf("%w: more than %d records", ErrTooLarge, lim.MaxRecords)
		}
		nameLen, extraLen, commentLen := int(le16(hdr[28:])), int(le16(hdr[30:])), int(le16(hdr[32:]))
		recLen := int64(cdHeaderLen + nameLen + extraLen + commentLen)
		if recLen > dir.size-pos {
			return nil, notZip("central directory record exceeds the directory")
		}
		idx := -1
		skip := nameLen + extraLen + commentLen
		if nameLen <= maxName {
			if _, err := io.ReadFull(br, nameBuf[:nameLen]); err != nil {
				return nil, classify(err, "central directory")
			}
			skip -= nameLen
			if i, ok := want[string(nameBuf[:nameLen])]; ok {
				idx = i
			}
		}
		if idx >= 0 && found[idx] != nil {
			dup[idx] = true
		} else if idx >= 0 {
			e := &cdEntry{flags: le16(hdr[8:]), method: le16(hdr[10:]), crc: binary.LittleEndian.Uint32(hdr[16:]),
				csize: le32(hdr[20:]), usize: le32(hdr[24:]), offset: le32(hdr[42:])}
			if extraBuf == nil {
				extraBuf = make([]byte, 0xFFFF)
			}
			if _, err := io.ReadFull(br, extraBuf[:extraLen]); err != nil {
				return nil, classify(err, "central directory")
			}
			skip -= extraLen
			if err := e.applyZip64(extraBuf[:extraLen], le16(hdr[34:])); err != nil {
				return nil, err
			}
			found[idx] = e
		}
		if _, err := br.Discard(skip); err != nil {
			return nil, classify(err, "central directory")
		}
		pos += recLen
	}
	var ambiguous []string
	for i, d := range dup {
		if d {
			ambiguous = append(ambiguous, fmt.Sprintf("%q", names[i]))
		}
	}
	if len(ambiguous) > 0 {
		return nil, fmt.Errorf("%w: %s occurs more than once", ErrAmbiguous, strings.Join(ambiguous, ", "))
	}
	return found, nil
}

// applyZip64 takes the 64-bit sizes/offset from the Zip64 extended information extra field for the
// 32-bit fields that hold the 0xFFFFFFFF marker (in the order the format defines).
func (e *cdEntry) applyZip64(extra []byte, disk uint64) error {
	needU, needC, needO, needD := e.usize == magic32, e.csize == magic32, e.offset == magic32, disk == magic16
	if !needU && !needC && !needO {
		return nil
	}
	for len(extra) >= 4 {
		id, n := le16(extra), int(le16(extra[2:]))
		if n > len(extra)-4 {
			return notZip("bad extra field")
		}
		data := extra[4 : 4+n]
		extra = extra[4+n:]
		if id != zip64ExtraID {
			continue
		}
		for _, f := range []struct {
			need bool
			dst  *uint64
			size int
		}{{needU, &e.usize, 8}, {needC, &e.csize, 8}, {needO, &e.offset, 8}, {needD, nil, 4}} {
			if !f.need {
				continue
			}
			if len(data) < f.size {
				return notZip("short Zip64 extra field")
			}
			if f.dst != nil {
				*f.dst = le64(data)
			}
			data = data[f.size:]
		}
		return nil
	}
	return notZip("missing Zip64 extra field")
}

// readEntry decompresses at most maxBytes of a requested entry and verifies what it can.
func (s *source) readEntry(dir *directory, e *cdEntry, name string, maxBytes int) ([]byte, bool, error) {
	if e.flags&(flagEncrypted|flagStrongEncrypted) != 0 {
		return nil, false, notZip("%q is encrypted", name)
	}
	if e.method != methodStored && e.method != methodDeflated {
		return nil, false, notZip("%q uses unsupported compression method %d", name, e.method)
	}
	if e.usize > maxSafeInteger {
		return nil, false, notZip("%q declares an impossible size", name)
	}
	// Entries live before the central directory: [base+offset, base+offset+header+data) ⊆ [0, start).
	room := uint64(dir.start - dir.base)
	if e.offset > room || room-e.offset < localLen {
		return nil, false, notZip("%q: local header outside the archive", name)
	}
	hdrPos := dir.base + int64(e.offset)
	var lh [localLen]byte
	if err := s.readAt(lh[:], hdrPos); err != nil {
		return nil, false, err
	}
	if le32(lh[:]) != localSig {
		return nil, false, notZip("%q: bad local header signature", name)
	}
	if le16(lh[6:])&(flagEncrypted|flagStrongEncrypted) != 0 {
		return nil, false, notZip("%q is encrypted", name)
	}
	nameLen, extraLen := int64(le16(lh[26:])), int64(le16(lh[28:]))
	dataPos := hdrPos + localLen + nameLen + extraLen
	if nameLen != int64(len(name)) || dataPos > dir.start {
		return nil, false, notZip("%q: local header does not match the central directory", name)
	}
	localName := make([]byte, nameLen)
	if err := s.readAt(localName, hdrPos+localLen); err != nil {
		return nil, false, err
	}
	if string(localName) != name {
		return nil, false, notZip("%q: local header names a different entry", name)
	}
	if e.csize > uint64(dir.start-dataPos) {
		return nil, false, notZip("%q: data overlaps the central directory", name)
	}
	var r io.Reader = io.NewSectionReader(s, dataPos, int64(e.csize))
	if e.method == methodStored {
		if e.csize != e.usize {
			return nil, false, notZip("%q: stored entry with different sizes", name)
		}
	} else {
		fr := flate.NewReader(r)
		defer fr.Close()
		r = fr
	}
	limit := maxBytes
	if e.usize < uint64(limit) {
		limit = int(e.usize)
	}
	buf := make([]byte, limit)
	n, done, err := readUpTo(r, buf)
	if err != nil {
		return nil, false, classify(err, fmt.Sprintf("%q", name))
	}
	if !done {
		var one [1]byte
		m, err := io.ReadFull(r, one[:])
		switch {
		case m == 1:
		case err == io.EOF:
			done = true
		default:
			return nil, false, classify(err, fmt.Sprintf("%q", name))
		}
	}
	if done {
		if uint64(n) != e.usize {
			return nil, false, notZip("%q: size differs from the central directory", name)
		}
		if crc32.ChecksumIEEE(buf[:n]) != e.crc {
			return nil, false, notZip("%q: CRC mismatch", name)
		}
	} else if e.usize <= uint64(maxBytes) {
		return nil, false, notZip("%q: longer than declared", name)
	}
	return buf[:n], done, nil
}

// readUpTo fills buf from r; done reports a clean end of data (io.EOF) before buf was full.
func readUpTo(r io.Reader, buf []byte) (n int, done bool, err error) {
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if err == io.EOF {
			return n, true, nil
		}
		if err != nil {
			return n, false, err
		}
	}
	return n, false, nil
}

// Text turns entry bytes into untrusted text for a JSON result: invalid UTF-8 and control characters
// other than TAB/LF/CR become U+FFFD, and the text is cut at a code point so that its JSON-encoded
// length (protocol.Marshal, quotes included) is ≤ maxEncoded. complete=false means data is only a
// prefix of the entry (an incomplete trailing sequence is dropped, not replaced). truncated reports
// that anything of the entry is missing from the text.
func Text(data []byte, complete bool, maxEncoded int) (text string, truncated bool) {
	truncated = !complete
	if !complete {
		data = trimIncompleteRune(data)
	}
	var b strings.Builder
	b.Grow(min(len(data), maxEncoded))
	n := 2
	for i := 0; i < len(data); {
		r, size := utf8.DecodeRune(data[i:])
		if (r == utf8.RuneError && size == 1) || (unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r') {
			r = utf8.RuneError
		}
		l := protocol.JSONRuneLen(r, false)
		if n+l > maxEncoded {
			truncated = true
			break
		}
		n += l
		b.WriteRune(r)
		i += size
	}
	return b.String(), truncated
}

// trimIncompleteRune drops a trailing UTF-8 sequence that is a valid but incomplete prefix.
func trimIncompleteRune(b []byte) []byte {
	for k := 1; k < utf8.UTFMax && k <= len(b); k++ {
		if utf8.RuneStart(b[len(b)-k]) {
			if !utf8.FullRune(b[len(b)-k:]) {
				return b[:len(b)-k]
			}
			return b
		}
	}
	return b
}
