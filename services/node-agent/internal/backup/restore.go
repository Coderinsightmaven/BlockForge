package backup

import (
	"fmt"
	"time"

	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

// fsopsArchiveOptions configures extraction for a restore: fs.extract safety rules, archive
// permission bits (masked to 0777), truncate (everything except .blockforge/) only after the archive
// has been fully validated, and throttled progress.
func fsopsArchiveOptions(p *protocol.BackupRestorePayload, root *fsops.Root, progress Progress, last *time.Time) fsops.ArchiveOptions {
	o := fsops.ArchiveOptions{MaxTotalBytes: p.MaxTotalBytes, MaxEntries: restoreMaxEntries, KeepPerms: true}
	if p.Truncate {
		o.BeforeWrite = func() error {
			if progress != nil {
				progress("truncate", "removing existing files", nil)
			}
			return root.Truncate(".blockforge")
		}
	}
	if progress != nil {
		o.Progress = func(entries, bytes int64) {
			if time.Since(*last) >= progressEvery {
				*last = time.Now()
				progress("extract", fmt.Sprintf("%d entries, %d MiB", entries, mib(bytes)), ptrPct(bytes, p.MaxTotalBytes))
			}
		}
	}
	return o
}
