package fsops

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Staged backup restore. Nothing in the data directory changes until the whole archive has been
// extracted successfully somewhere else on the same filesystem:
//
//   - truncate: the archive is extracted into <base>/data.restore-<ts> (a sibling of data, not
//     visible to the container). Then a journal (<base>/restore.journal) is written, data is renamed
//     to data.old-<ts>, the staging directory to data, the previous .blockforge/ moves into the new
//     data directory, data.old-<ts> is removed and the journal deleted. A failure before the swap
//     removes the staging directory and leaves data untouched; RecoverRestores (agent start) rolls
//     back or completes a swap interrupted by a crash.
//   - merge: the archive is extracted into data/.blockforge/restore-<ts>; only then, after checking
//     that no restored file collides with an existing directory (or the reverse), are the entries
//     renamed into place inside the data root.
const (
	restoreJournalName = "restore.journal"
	stagingPrefix      = "data.restore-"
	oldDataPrefix      = "data.old-"
	mergeStagingPrefix = "restore-" // inside data/.blockforge
	agentArea          = ".blockforge"
)

// RestoreOptions configure RestoreArchive.
type RestoreOptions struct {
	ArchiveOptions
	// Truncate replaces the data directory (except .blockforge/); otherwise the archive is merged.
	Truncate bool
	// Stage reports the swap / merge phase.
	Stage func(stage, message string)
	Log   *slog.Logger
}

type swapJournal struct {
	Staging string `json:"staging"`
	Old     string `json:"old"`
}

func (o *RestoreOptions) stage(stage, msg string) {
	if o.Stage != nil {
		o.Stage(stage, msg)
	}
}

func (o *RestoreOptions) log() *slog.Logger {
	if o.Log != nil {
		return o.Log
	}
	return slog.Default()
}

// openAt opens dir (agent-chosen, absolute) as a sandbox root.
func (s *Sandbox) openAt(dir string) (*Root, error) {
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &Root{r: r, s: s, info: &rootInfo{dir: dir}}, nil
}

func (s *Sandbox) chownPath(p string) error {
	if !s.Chown {
		return nil
	}
	return os.Lchown(p, s.UID, s.GID)
}

// RestoreArchive restores a (verified) backup archive into the workload's data directory with the
// fs.extract safety rules (o.ArchiveOptions), staged as described above.
func (s *Sandbox) RestoreArchive(id string, f *os.File, size int64, o RestoreOptions) (*ExtractResult, error) {
	if err := s.EnsureDataDir(id); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
	}
	ts := strconv.FormatInt(time.Now().UnixNano(), 10)
	if o.Truncate {
		return s.restoreSwap(id, f, size, ts, &o)
	}
	return s.restoreMerge(id, f, size, ts, &o)
}

func (s *Sandbox) restoreSwap(id string, f *os.File, size int64, ts string, o *RestoreOptions) (*ExtractResult, error) {
	base := s.WorkloadBase(id)
	j := swapJournal{Staging: stagingPrefix + ts, Old: oldDataPrefix + ts}
	staging := filepath.Join(base, j.Staging)
	if err := os.Mkdir(staging, 0o750); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "create restore staging directory: %v", err)
	}
	discard := func() { _ = os.RemoveAll(staging) }
	if err := s.chownPath(staging); err != nil {
		discard()
		return nil, protocol.Errorf(protocol.CodeInternal, "chown restore staging directory: %v", err)
	}
	root, err := s.openAt(staging)
	if err != nil {
		discard()
		return nil, protocol.Errorf(protocol.CodeInternal, "open restore staging directory: %v", err)
	}
	res, err := root.ExtractFrom(f, size, ".", o.ArchiveOptions)
	root.Close()
	if err != nil {
		discard()
		return nil, err
	}
	// The agent area always comes from the current data directory.
	if err := os.RemoveAll(filepath.Join(staging, agentArea)); err != nil {
		discard()
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare restored data: %v", err)
	}
	o.stage("swap", "replacing the data directory")
	if err := s.swapIn(base, j, o.log()); err != nil {
		return nil, err
	}
	if err := s.EnsureDataDir(id); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "prepare data directory: %v", err)
	}
	return res, nil
}

// swapIn replaces <base>/data with the staging directory named in j (journaled; see RecoverRestores).
func (s *Sandbox) swapIn(base string, j swapJournal, log *slog.Logger) error {
	data := filepath.Join(base, "data")
	staging := filepath.Join(base, j.Staging)
	old := filepath.Join(base, j.Old)
	journal := filepath.Join(base, restoreJournalName)
	abandon := func() {
		_ = os.RemoveAll(staging)
		_ = os.Remove(journal)
		fileutil.SyncDir(base)
	}
	b, _ := json.Marshal(j)
	if err := fileutil.WriteFileAtomic(journal, b, 0o600); err != nil {
		abandon()
		return protocol.Errorf(protocol.CodeInternal, "write restore journal: %v", err)
	}
	if err := os.Rename(data, old); err != nil {
		abandon()
		return protocol.Errorf(protocol.CodeInternal, "move the current data aside: %v", err)
	}
	if err := os.Rename(staging, data); err != nil {
		if rerr := os.Rename(old, data); rerr != nil {
			// The journal stays: the next agent start puts the old data back.
			log.Error("restore swap failed and the old data could not be put back yet", "base", base, "err", err, "rollbackErr", rerr)
			return protocol.Errorf(protocol.CodeInternal, "swap in restored data: %v (rollback pending)", err)
		}
		abandon()
		return protocol.Errorf(protocol.CodeInternal, "swap in restored data: %v", err)
	}
	fileutil.SyncDir(base)
	if err := finishSwap(base, j); err != nil {
		// The restored data is in place; the next agent start retries the cleanup.
		log.Error("restored data is in place but cleaning up the previous data failed; retried on the next agent start",
			"base", base, "err", err)
	}
	return nil
}

// finishSwap moves the previous .blockforge/ into the restored data directory, removes the old data
// directory and the journal.
func finishSwap(base string, j swapJournal) error {
	data := filepath.Join(base, "data")
	oldArea := filepath.Join(base, j.Old, agentArea)
	newArea := filepath.Join(data, agentArea)
	if _, err := os.Lstat(oldArea); err == nil {
		if _, err := os.Lstat(newArea); errors.Is(err, fs.ErrNotExist) {
			if err := os.Rename(oldArea, newArea); err != nil {
				return err
			}
			fileutil.SyncDir(data)
		}
	}
	if err := os.RemoveAll(filepath.Join(base, j.Old)); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(base, restoreJournalName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	fileutil.SyncDir(base)
	return nil
}

func (s *Sandbox) restoreMerge(id string, f *os.File, size int64, ts string, o *RestoreOptions) (*ExtractResult, error) {
	root, err := s.Open(id)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	// The staging directory lives in the agent area, which must be a real directory.
	if fi, err := root.r.Lstat(agentArea); err != nil || !fi.IsDir() {
		if err == nil {
			_ = root.r.Remove(agentArea)
		}
		if err := root.r.Mkdir(agentArea, 0o750); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, MapError("restore", agentArea, err)
		}
		_ = root.chown(agentArea)
	}
	staging := agentArea + "/" + mergeStagingPrefix + ts
	if err := root.r.Mkdir(staging, 0o750); err != nil {
		return nil, MapError("restore", staging, err)
	}
	defer func() { _ = root.r.RemoveAll(staging) }()
	if err := root.chown(staging); err != nil {
		return nil, MapError("restore", staging, err)
	}
	res, err := root.ExtractFrom(f, size, staging, o.ArchiveOptions)
	if err != nil {
		return nil, err
	}
	o.stage("merge", "moving restored files into place")
	if err := root.mergeFrom(staging, false); err != nil {
		return nil, err
	}
	if err := root.mergeFrom(staging, true); err != nil {
		return nil, err
	}
	return res, nil
}

// mergeFrom checks (move=false) or performs (move=true) moving the staged tree over the data root:
// a missing directory is moved as a whole, an existing one is merged into, files replace files
// (and symlinks); a file/directory collision fails the check before anything moved.
func (r *Root) mergeFrom(staging string, move bool) error {
	return fs.WalkDir(r.r.FS(), staging, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if fp == staging {
			return nil
		}
		rel := strings.TrimPrefix(fp, staging+"/")
		if rel == agentArea { // never restored into the agent area
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			fi, err := r.r.Stat(rel)
			switch {
			case errors.Is(err, fs.ErrNotExist):
				if _, lerr := r.r.Lstat(rel); lerr == nil {
					return protocol.Errorf(protocol.CodeConflict, "restored directory %q collides with a dangling symlink", rel)
				}
				if move {
					if err := r.r.Rename(fp, rel); err != nil {
						return MapError("restore", rel, err)
					}
					r.syncDir(path.Dir(rel))
				}
				return fs.SkipDir
			case err != nil:
				return MapError("restore", rel, err)
			case !fi.IsDir():
				return protocol.Errorf(protocol.CodeConflict, "restored directory %q collides with an existing file", rel)
			}
			return nil
		}
		if fi, err := r.r.Lstat(rel); err == nil && fi.IsDir() {
			return protocol.Errorf(protocol.CodeConflict, "restored file %q collides with an existing directory", rel)
		} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return MapError("restore", rel, err)
		}
		if move {
			if err := r.r.Rename(fp, rel); err != nil {
				return MapError("restore", rel, err)
			}
			r.syncDir(path.Dir(rel))
		}
		return nil
	})
}

// ---------------------------------------------------------------------------
// Crash recovery

func validSwapName(name, prefix string) bool {
	rest, ok := strings.CutPrefix(name, prefix)
	if !ok || rest == "" {
		return false
	}
	for _, c := range rest {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// RecoverRestores repairs restores interrupted by an agent crash; it must run at agent start before
// anything (re)creates workload data directories. For every workload:
//   - journal, data missing, data.old-<ts> present → roll back (data.old → data), drop the staging dir;
//   - journal, data and data.old present, staging gone → the swap happened: finish it;
//   - journal, data present, no data.old → the swap never started: drop the staging dir;
//   - no journal: staging directories of interrupted extractions are removed; a data.old-* without a
//     data directory is renamed back; merge staging leftovers in data/.blockforge are removed.
func (s *Sandbox) RecoverRestores(log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	entries, err := os.ReadDir(filepath.Join(s.DataRoot, "servers"))
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && protocol.IsUUID(e.Name()) {
			s.recoverOne(e.Name(), log)
		}
	}
}

func (s *Sandbox) recoverOne(id string, log *slog.Logger) {
	base := s.WorkloadBase(id)
	data := filepath.Join(base, "data")
	journal := filepath.Join(base, restoreJournalName)
	if b, err := os.ReadFile(journal); err == nil {
		var j swapJournal
		if json.Unmarshal(b, &j) != nil || !validSwapName(j.Staging, stagingPrefix) || !validSwapName(j.Old, oldDataPrefix) {
			log.Error("unreadable restore journal; leaving the workload directory for an operator", "workload", id)
			return
		}
		staging, old := filepath.Join(base, j.Staging), filepath.Join(base, j.Old)
		dataOK, oldOK, stagingOK := exists(data), exists(old), exists(staging)
		switch {
		case !dataOK && oldOK:
			if err := os.Rename(old, data); err != nil {
				log.Error("could not roll back an interrupted restore", "workload", id, "err", err)
				return
			}
			_ = os.RemoveAll(staging)
			_ = os.Remove(journal)
			fileutil.SyncDir(base)
			log.Warn("rolled back a restore interrupted during the directory swap; the previous data is back", "workload", id)
		case dataOK && oldOK && !stagingOK:
			if err := finishSwap(base, j); err != nil {
				log.Error("could not finish an interrupted restore", "workload", id, "err", err)
				return
			}
			log.Warn("finished a restore interrupted after the directory swap", "workload", id)
		case dataOK && !oldOK:
			_ = os.RemoveAll(staging)
			_ = os.Remove(journal)
			fileutil.SyncDir(base)
			if stagingOK {
				log.Warn("discarded a restore interrupted before the directory swap; data unchanged", "workload", id)
			}
		default:
			log.Error("inconsistent restore state; leaving it for an operator", "workload", id,
				"data", dataOK, "old", oldOK, "staging", stagingOK)
			return
		}
	}
	names, err := os.ReadDir(base)
	if err != nil {
		return
	}
	var olds []string
	for _, n := range names {
		switch {
		case validSwapName(n.Name(), stagingPrefix):
			_ = os.RemoveAll(filepath.Join(base, n.Name()))
			log.Warn("removed the staging directory of an interrupted restore", "workload", id, "dir", n.Name())
		case validSwapName(n.Name(), oldDataPrefix):
			olds = append(olds, n.Name())
		}
	}
	if len(olds) > 0 {
		if exists(data) {
			log.Warn("previous data directories left by a restore; not touched", "workload", id, "dirs", olds)
		} else {
			sort.Strings(olds)
			newest := olds[len(olds)-1]
			if err := os.Rename(filepath.Join(base, newest), data); err != nil {
				log.Error("could not roll back an interrupted restore", "workload", id, "err", err)
			} else {
				fileutil.SyncDir(base)
				log.Warn("rolled back an interrupted restore", "workload", id, "dir", newest)
			}
		}
	}
	if root, err := os.OpenRoot(data); err == nil {
		if d, err := root.Open(agentArea); err == nil {
			list, _ := d.Readdirnames(-1)
			d.Close()
			for _, n := range list {
				if validSwapName(n, mergeStagingPrefix) {
					_ = root.RemoveAll(agentArea + "/" + n)
					log.Warn("removed the staging directory of an interrupted merge restore", "workload", id, "dir", n)
				}
			}
		}
		root.Close()
	}
}
