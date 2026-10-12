package jarread

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"hash/crc32"
	"testing"
)

// A minimal zip writer with full control over every field, for building malformed archives.

type zentry struct {
	name       string
	data       []byte // uncompressed content
	method     uint16 // 0 stored, 8 deflate; anything else stores data as-is
	flags      uint16
	descriptor bool // flag 3: sizes/CRC zero in the local header, data descriptor after the data
	zip64      bool // central directory sizes/offset as 0xFFFFFFFF + Zip64 extra field
	noZip64Ext bool // with zip64: omit the extra field (malformed)

	localName *string // overrides the local header name
	localFlag *uint16 // overrides the local header flags
	crc       *uint32 // overrides the central directory CRC
	usize     *uint64 // overrides the central directory uncompressed size
	csize     *uint64 // overrides the central directory compressed size
	offset    *uint64 // overrides the central directory local header offset
	comp      []byte  // overrides the compressed bytes
}

type zopts struct {
	prefix    []byte // bytes before the archive; offsets are relative to the archive (a "stub")
	trailing  []byte // bytes after the end record
	comment   string
	total     *uint64 // overrides the declared number of records
	cdSize    *uint64 // overrides the declared central directory size
	cdOff     *uint64 // overrides the declared central directory offset
	zip64EOCD bool    // write a Zip64 end record + locator (32-bit fields hold the markers)
	cdPad     []byte  // bytes after the last record, counted in the directory size
}

func u16p(v uint16) *uint16 { return &v }
func u32p(v uint32) *uint32 { return &v }
func u64p(v uint64) *uint64 { return &v }
func strp(v string) *string { return &v }

func deflate(t testing.TB, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w, _ := flate.NewWriter(&b, flate.BestSpeed)
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	w.Close()
	return b.Bytes()
}

type le struct{ bytes.Buffer }

func (w *le) u16(v uint64) { binary.Write(&w.Buffer, binary.LittleEndian, uint16(v)) }
func (w *le) u32(v uint64) { binary.Write(&w.Buffer, binary.LittleEndian, uint32(v)) }
func (w *le) u64(v uint64) { binary.Write(&w.Buffer, binary.LittleEndian, v) }

func pick[T any](override *T, def T) T {
	if override != nil {
		return *override
	}
	return def
}

func buildZip(t testing.TB, entries []zentry, o zopts) []byte {
	t.Helper()
	var w le
	w.Write(o.prefix)
	start := uint64(len(o.prefix))
	type meta struct {
		crc          uint32
		csize, usize uint64
		off          uint64
	}
	metas := make([]meta, len(entries))
	for i, e := range entries {
		comp := e.data
		if e.method == 8 {
			comp = deflate(t, e.data)
		}
		if e.comp != nil {
			comp = e.comp
		}
		m := meta{crc: crc32.ChecksumIEEE(e.data), csize: uint64(len(comp)), usize: uint64(len(e.data)), off: uint64(w.Len()) - start}
		metas[i] = m
		flags := e.flags
		if e.descriptor {
			flags |= 0x8
		}
		lname := pick(e.localName, e.name)
		w.u32(localSig)
		w.u16(20)
		w.u16(uint64(pick(e.localFlag, flags)))
		w.u16(uint64(e.method))
		w.u16(0)
		w.u16(0x21)
		if e.descriptor {
			w.u32(0)
			w.u32(0)
			w.u32(0)
		} else {
			w.u32(uint64(m.crc))
			w.u32(m.csize)
			w.u32(m.usize)
		}
		w.u16(uint64(len(lname)))
		w.u16(0)
		w.WriteString(lname)
		w.Write(comp)
		if e.descriptor {
			w.u32(0x08074b50)
			w.u32(uint64(m.crc))
			w.u32(m.csize)
			w.u32(m.usize)
		}
	}
	cdStart := uint64(w.Len()) - start
	for i, e := range entries {
		m := metas[i]
		flags := e.flags
		if e.descriptor {
			flags |= 0x8
		}
		crc, cs, us, off := pick(e.crc, m.crc), pick(e.csize, m.csize), pick(e.usize, m.usize), pick(e.offset, m.off)
		var extra le
		if e.zip64 && !e.noZip64Ext {
			extra.u16(zip64ExtraID)
			extra.u16(24)
			extra.u64(us)
			extra.u64(cs)
			extra.u64(off)
		}
		if e.zip64 {
			cs, us, off = magic32, magic32, magic32
		}
		w.u32(cdSig)
		w.u16(45)
		w.u16(20)
		w.u16(uint64(flags))
		w.u16(uint64(e.method))
		w.u16(0)
		w.u16(0x21)
		w.u32(uint64(crc))
		w.u32(cs)
		w.u32(us)
		w.u16(uint64(len(e.name)))
		w.u16(uint64(extra.Len()))
		w.u16(0)
		w.u16(0)
		w.u16(0)
		w.u32(0)
		w.u32(off)
		w.WriteString(e.name)
		w.Write(extra.Bytes())
	}
	w.Write(o.cdPad)
	cdSize := pick(o.cdSize, uint64(w.Len())-start-cdStart)
	total := pick(o.total, uint64(len(entries)))
	cdOff := pick(o.cdOff, cdStart)
	if o.zip64EOCD {
		recPos := uint64(w.Len())
		w.u32(zip64EndSig)
		w.u64(44)
		w.u16(45)
		w.u16(45)
		w.u32(0)
		w.u32(0)
		w.u64(total)
		w.u64(total)
		w.u64(cdSize)
		w.u64(cdOff)
		w.u32(zip64LocSig)
		w.u32(0)
		w.u64(recPos)
		w.u32(1)
		total, cdSize, cdOff = magic16, magic32, magic32
	}
	w.u32(eocdSig)
	w.u16(0)
	w.u16(0)
	w.u16(min(total, magic16))
	w.u16(min(total, magic16))
	w.u32(min(cdSize, magic32))
	w.u32(min(cdOff, magic32))
	w.u16(uint64(len(o.comment)))
	w.WriteString(o.comment)
	w.Write(o.trailing)
	return w.Bytes()
}
