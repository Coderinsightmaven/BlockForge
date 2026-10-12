package backup

import (
	"fmt"
	"time"

	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

// restoreOptions configures a staged restore: fs.extract safety rules, archive permission bits
// (masked to 0777), the free-disk reserve checked against the staged copy (the archive's expanded
// size) before anything is written, and throttled progress.
func (m *Manager) restoreOptions(p *protocol.BackupRestorePayload, progress Progress) fsops.RestoreOptions {
	o := fsops.RestoreOptions{
		ArchiveOptions: fsops.ArchiveOptions{MaxTotalBytes: p.MaxTotalBytes, MaxEntries: restoreMaxEntries, KeepPerms: true},
		Truncate:       p.Truncate,
		Log:            m.logger(),
	}
	dataDir := m.Sandbox.DataDir(p.WorkloadID)
	var planned int64
	o.Planned = func(entries, bytes int64) error {
		planned = bytes
		if free, ok := m.free(dataDir); ok && free-bytes < m.reserve() {
			return protocol.Errorf(protocol.CodeQuotaExceeded,
				"restoring needs %d bytes for the staged copy but only %d are free (the agent keeps %d free)", bytes, free, m.reserve()).
				WithDetails(map[string]any{"bytes": bytes, "free": free, "reserve": m.reserve()})
		}
		return nil
	}
	if progress != nil {
		last := time.Now()
		o.Progress = func(entries, bytes int64) {
			if time.Since(last) >= progressEvery {
				last = time.Now()
				progress("extract", fmt.Sprintf("%d entries, %d of %d MiB", entries, mib(bytes), mib(planned)), ptrPct(bytes, planned))
			}
		}
		o.Stage = func(stage, msg string) { progress(stage, msg, nil) }
	}
	return o
}
