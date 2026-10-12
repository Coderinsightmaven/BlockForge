package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Command types (AGENT_COMMANDS keys in commands.ts).
const (
	CmdNodeFacts          = "node.facts"
	CmdNodePorts          = "node.ports"
	CmdWorkloadInstall    = "workload.install"
	CmdFsCopy             = "fs.copy"
	CmdFsCompress         = "fs.compress"
	CmdFsChmod            = "fs.chmod"
	CmdFsFind             = "fs.find"
	CmdBackupCreate       = "backup.create"
	CmdBackupUpload       = "backup.upload"
	CmdBackupRestore      = "backup.restore"
	CmdBackupDelete       = "backup.delete"
	CmdBackupTransferPush = "backup.transfer.push"
	CmdNodeProbe          = "node.probe"
	CmdWorkloadEnsure     = "workload.ensure"
	CmdWorkloadStart      = "workload.start"
	CmdWorkloadStop       = "workload.stop"
	CmdWorkloadKill       = "workload.kill"
	CmdWorkloadRemove     = "workload.remove"
	CmdWorkloadStatus     = "workload.status"
	CmdWorkloadConsole    = "workload.console"
	CmdWorkloadLogsTail   = "workload.logs.tail"
	CmdFsList             = "fs.list"
	CmdFsStat             = "fs.stat"
	CmdFsRead             = "fs.read"
	CmdFsWrite            = "fs.write"
	CmdFsMkdir            = "fs.mkdir"
	CmdFsRename           = "fs.rename"
	CmdFsDelete           = "fs.delete"
	CmdFsDu               = "fs.du"
	CmdFsExtract          = "fs.extract"
	CmdFsTransferPush     = "fs.transfer.push"
	CmdFsTransferPull     = "fs.transfer.pull"
	CmdArtifactFetch      = "artifact.fetch"
	CmdCredentialsRotate  = "credentials.rotate"
	CmdFsHash             = "fs.hash"
	CmdJarReadEntries     = "jar.readEntries"
)

// JAR_READ_LIMITS in commands.ts (bounds of the jar reader).
const (
	JarMaxCentralDirectoryRecords = 65_536
	JarMaxCentralDirectoryBytes   = 16 * 1024 * 1024
	JarMaxEntryBytes              = 256 * 1024
	JarMaxTotalBytes              = 8 * 1024 * 1024
)

// Per-file / per-jar error codes of fs.hash and jar.readEntries (FsHashEntry / JarReadResult).
const (
	ScanNotFound       = "NOT_FOUND"
	ScanNotRegular     = "NOT_REGULAR"
	ScanTooLarge       = "TOO_LARGE"
	ScanPathForbidden  = "PATH_FORBIDDEN"
	ScanIOError        = "IO_ERROR"
	ScanBudgetExceeded = "BUDGET_EXCEEDED"
	ScanNotAZip        = "NOT_A_ZIP"
	ScanAmbiguousEntry = "AMBIGUOUS_ENTRY"
)

// ---------------------------------------------------------------------------
// Typed payloads (after defaults are applied)

type EmptyPayload struct{}

type NodeProbePayload struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Kind      string `json:"kind"`
	TimeoutMs int64  `json:"timeoutMs"`
}

type PortBinding struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
	HostIP        string `json:"hostIp"`
	Protocol      string `json:"protocol"`
}

type WorkloadNetwork struct {
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
}

type RestartPolicy struct {
	Mode       string `json:"mode"`
	MaxRetries int    `json:"maxRetries"`
	BackoffMs  int64  `json:"backoffMs"`
}

// WorkloadStop is the stop action: a console command or a signal (workload.ts WorkloadStop).
type WorkloadStop struct {
	Type    string `json:"type"`
	Command string `json:"command,omitempty"`
	Signal  string `json:"signal,omitempty"`
}

// Entrypoint modes.
const (
	EntrypointArgv  = "argv"
	EntrypointImage = "image"
)

// WorkloadSpec is the payload of workload.ensure (workload.ts WorkloadSpec).
type WorkloadSpec struct {
	WorkloadID         string            `json:"workloadId"`
	Kind               string            `json:"kind"`
	Image              string            `json:"image"`
	Entrypoint         string            `json:"entrypoint"`
	Command            []string          `json:"command"`
	Env                map[string]string `json:"env"`
	DataMountPath      string            `json:"dataMountPath"`
	ReadOnlyRootfs     bool              `json:"readOnlyRootfs"`
	MemoryLimitBytes   int64             `json:"memoryLimitBytes"`
	CPULimitMillicores *int64            `json:"cpuLimitMillicores"`
	PidsLimit          int64             `json:"pidsLimit"`
	Ports              []PortBinding     `json:"ports"`
	Networks           []WorkloadNetwork `json:"networks"`
	Stop               *WorkloadStop     `json:"stop"`
	StopTimeoutMs      int64             `json:"stopTimeoutMs"`
	RestartPolicy      RestartPolicy     `json:"restartPolicy"`
	JvmProbe           bool              `json:"jvmProbe"`
	Labels             map[string]string `json:"labels"`
}

type WorkloadRef struct {
	WorkloadID string `json:"workloadId"`
}

// WorkloadInstallPayload is the payload of workload.install.
type WorkloadInstallPayload struct {
	WorkloadID         string            `json:"workloadId"`
	Image              string            `json:"image"`
	Entrypoint         string            `json:"entrypoint"`
	Script             string            `json:"script"`
	Env                map[string]string `json:"env"`
	MemoryLimitBytes   int64             `json:"memoryLimitBytes"`
	CPULimitMillicores *int64            `json:"cpuLimitMillicores"`
	TimeoutMs          int64             `json:"timeoutMs"`
}

// WorkloadInstallResult is the result of workload.install.
type WorkloadInstallResult struct {
	ExitCode   int      `json:"exitCode"`
	DurationMs int64    `json:"durationMs"`
	TimedOut   bool     `json:"timedOut"`
	LogTail    []string `json:"logTail"`
}

type FsCompressPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist      []string `json:"denylist,omitempty"`
	Root          string   `json:"root"`
	Paths         []string `json:"paths"`
	Format        string   `json:"format"`
	DestPath      string   `json:"destPath,omitempty"`
	MaxTotalBytes int64    `json:"maxTotalBytes"`
}

type FsChmodPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist []string `json:"denylist,omitempty"`
	Path     string   `json:"path"`
	Mode     uint32   `json:"mode"`
}

type FsFindPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	Query      string `json:"query"`
	MaxResults int    `json:"maxResults"`
}

// BackupCreatePayload is the payload of backup.create.
type BackupCreatePayload struct {
	WorkloadID string   `json:"workloadId"`
	BackupID   string   `json:"backupId"`
	Ignore     []string `json:"ignore"`
	MaxBytes   int64    `json:"maxBytes"`
}

type BackupUploadPart struct {
	PartNumber int    `json:"partNumber"`
	URL        string `json:"url"`
}

// BackupUploadPayload is the payload of backup.upload (presigned multipart PUT URLs).
type BackupUploadPayload struct {
	WorkloadID  string             `json:"workloadId"`
	BackupID    string             `json:"backupId"`
	PartSize    int64              `json:"partSize"`
	Parts       []BackupUploadPart `json:"parts"`
	DeleteLocal bool               `json:"deleteLocal"`
}

type BackupSource struct {
	Type string `json:"type"`
	URL  string `json:"url,omitempty"`
}

// BackupRestorePayload is the payload of backup.restore.
type BackupRestorePayload struct {
	WorkloadID    string       `json:"workloadId"`
	BackupID      string       `json:"backupId"`
	Source        BackupSource `json:"source"`
	Sha256        string       `json:"sha256"`
	Truncate      bool         `json:"truncate"`
	MaxTotalBytes int64        `json:"maxTotalBytes"`
}

// BackupRefPayload is the payload of backup.delete.
type BackupRefPayload struct {
	WorkloadID string `json:"workloadId"`
	BackupID   string `json:"backupId"`
}

// BackupTransferPushPayload is the payload of backup.transfer.push.
type BackupTransferPushPayload struct {
	WorkloadID string `json:"workloadId"`
	BackupID   string `json:"backupId"`
	TransferID string `json:"transferId"`
}

// ArtifactResult is the result of artifact.fetch and fs.transfer.*.
type ArtifactResult struct {
	Bytes  int64  `json:"bytes"`
	Sha256 string `json:"sha256"`
	Cached bool   `json:"cached"`
}

type WorkloadStopPayload struct {
	WorkloadID string `json:"workloadId"`
	TimeoutMs  int64  `json:"timeoutMs"`
}

type WorkloadRemovePayload struct {
	WorkloadID string `json:"workloadId"`
	DeleteData bool   `json:"deleteData"`
}

type WorkloadStatusPayload struct {
	WorkloadID string `json:"workloadId,omitempty"`
}

type WorkloadConsolePayload struct {
	WorkloadID string `json:"workloadId"`
	Line       string `json:"line"`
}

type WorkloadLogsTailPayload struct {
	WorkloadID string `json:"workloadId"`
	Lines      int    `json:"lines"`
	SinceTs    *int64 `json:"sinceTs,omitempty"`
}

type FsPathPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist []string `json:"denylist,omitempty"`
	Path     string   `json:"path"`
}

type FsReadPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist []string `json:"denylist,omitempty"`
	Path     string   `json:"path"`
	MaxBytes int64    `json:"maxBytes"`
}

// OptionalNullableString distinguishes a missing key, an explicit null and a value.
type OptionalNullableString struct {
	Set   bool
	Null  bool
	Value string
}

func (o *OptionalNullableString) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.Value)
}

func (o OptionalNullableString) MarshalJSON() ([]byte, error) {
	if !o.Set || o.Null {
		return []byte("null"), nil
	}
	return json.Marshal(o.Value)
}

type FsWritePayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist      []string               `json:"denylist,omitempty"`
	Path          string                 `json:"path"`
	Content       string                 `json:"content"`
	Encoding      string                 `json:"encoding"`
	IfMatchSha256 OptionalNullableString `json:"ifMatchSha256"`
	CreateParents bool                   `json:"createParents"`
}

type FsRenamePayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist []string `json:"denylist,omitempty"`
	From     string   `json:"from"`
	To       string   `json:"to"`
}

type FsDeletePayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist  []string `json:"denylist,omitempty"`
	Path      string   `json:"path"`
	Recursive bool     `json:"recursive"`
}

type FsDuPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	Depth      int    `json:"depth"`
	Top        int    `json:"top"`
}

type FsExtractPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist      []string `json:"denylist,omitempty"`
	ArchivePath   string   `json:"archivePath"`
	DestPath      string   `json:"destPath"`
	MaxTotalBytes int64    `json:"maxTotalBytes"`
	MaxEntries    int64    `json:"maxEntries"`
}

type FsTransferPushPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist   []string `json:"denylist,omitempty"`
	Path       string   `json:"path"`
	TransferID string   `json:"transferId"`
}

type FsTransferPullPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces (requested + resolved paths).
	Denylist   []string `json:"denylist,omitempty"`
	Path       string   `json:"path"`
	TransferID string   `json:"transferId"`
	MaxBytes   int64    `json:"maxBytes"`
}

type Checksum struct {
	Algorithm string `json:"algorithm"`
	Value     string `json:"value"`
}

type ArtifactFetchPayload struct {
	WorkloadID string    `json:"workloadId"`
	URL        string    `json:"url"`
	DestPath   string    `json:"destPath"`
	Checksum   *Checksum `json:"checksum"`
	MaxBytes   int64     `json:"maxBytes"`
	Cache      bool      `json:"cache"`
}

// FsHashPayload is the payload of fs.hash.
type FsHashPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces.
	Denylist        []string `json:"denylist,omitempty"`
	Paths           []string `json:"paths"`
	Algorithms      []string `json:"algorithms"`
	MaxBytesPerFile int64    `json:"maxBytesPerFile"`
	MaxTotalBytes   int64    `json:"maxTotalBytes"`
}

// FsHashEntry is one per-file outcome of fs.hash (commands.ts FsHashEntry, discriminated by ok).
type FsHashEntry struct {
	OK        bool
	Path      string
	SizeBytes int64
	Mtime     int64
	Sha1      string
	Sha256    string
	Sha512    string
	Error     string
}

type fsHashOK struct {
	OK        bool   `json:"ok"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Mtime     int64  `json:"mtime"`
	Sha1      string `json:"sha1,omitempty"`
	Sha256    string `json:"sha256,omitempty"`
	Sha512    string `json:"sha512,omitempty"`
}

type scanFailure struct {
	OK    bool   `json:"ok"`
	Path  string `json:"path"`
	Error string `json:"error"`
}

// MarshalJSON emits exactly the fields of the ok / error variant.
func (e FsHashEntry) MarshalJSON() ([]byte, error) {
	if !e.OK {
		return Marshal(scanFailure{Path: e.Path, Error: e.Error})
	}
	return Marshal(fsHashOK{OK: true, Path: e.Path, SizeBytes: e.SizeBytes, Mtime: e.Mtime, Sha1: e.Sha1, Sha256: e.Sha256, Sha512: e.Sha512})
}

// UnmarshalJSON decodes either variant.
func (e *FsHashEntry) UnmarshalJSON(b []byte) error {
	var v struct {
		fsHashOK
		Error string `json:"error"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*e = FsHashEntry{OK: v.OK, Path: v.Path, SizeBytes: v.SizeBytes, Mtime: v.Mtime, Sha1: v.Sha1, Sha256: v.Sha256, Sha512: v.Sha512, Error: v.Error}
	return nil
}

// FsHashResult is the result of fs.hash.
type FsHashResult struct {
	Files []FsHashEntry `json:"files"`
}

// JarReadEntriesPayload is the payload of jar.readEntries.
type JarReadEntriesPayload struct {
	WorkloadID string `json:"workloadId"`
	// Denylist is the template fileDenylist the agent enforces.
	Denylist      []string `json:"denylist,omitempty"`
	Paths         []string `json:"paths"`
	Entries       []string `json:"entries"`
	MaxEntryBytes int64    `json:"maxEntryBytes"`
	MaxJarBytes   int64    `json:"maxJarBytes"`
	MaxTotalBytes int64    `json:"maxTotalBytes"`
	Hash          []string `json:"hash"`
}

// JarEntryContent is one entry read by jar.readEntries.
type JarEntryContent struct {
	Name      string `json:"name"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

// JarReadResult is the per-jar outcome of jar.readEntries (commands.ts JarReadResult, discriminated by ok).
type JarReadResult struct {
	OK        bool
	Path      string
	SizeBytes int64
	Mtime     int64
	Sha1      string
	Sha512    string
	Entries   []JarEntryContent
	Missing   []string
	Error     string
}

type jarReadOK struct {
	OK        bool              `json:"ok"`
	Path      string            `json:"path"`
	SizeBytes int64             `json:"sizeBytes"`
	Mtime     int64             `json:"mtime"`
	Sha1      string            `json:"sha1,omitempty"`
	Sha512    string            `json:"sha512,omitempty"`
	Entries   []JarEntryContent `json:"entries"`
	Missing   []string          `json:"missing"`
}

// MarshalJSON emits exactly the fields of the ok / error variant (entries/missing always arrays).
func (j JarReadResult) MarshalJSON() ([]byte, error) {
	if !j.OK {
		return Marshal(scanFailure{Path: j.Path, Error: j.Error})
	}
	v := jarReadOK{OK: true, Path: j.Path, SizeBytes: j.SizeBytes, Mtime: j.Mtime, Sha1: j.Sha1, Sha512: j.Sha512, Entries: j.Entries, Missing: j.Missing}
	if v.Entries == nil {
		v.Entries = []JarEntryContent{}
	}
	if v.Missing == nil {
		v.Missing = []string{}
	}
	return Marshal(v)
}

// UnmarshalJSON decodes either variant.
func (j *JarReadResult) UnmarshalJSON(b []byte) error {
	var v struct {
		jarReadOK
		Error string `json:"error"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*j = JarReadResult{OK: v.OK, Path: v.Path, SizeBytes: v.SizeBytes, Mtime: v.Mtime, Sha1: v.Sha1, Sha512: v.Sha512,
		Entries: v.Entries, Missing: v.Missing, Error: v.Error}
	return nil
}

// JarReadEntriesResult is the result of jar.readEntries.
type JarReadEntriesResult struct {
	Jars []JarReadResult `json:"jars"`
}

// CredentialsRotateResult is the result of credentials.rotate (§3.1).
type CredentialsRotateResult struct {
	PublicKey string `json:"publicKey"`
	Proof     string `json:"proof"`
}

// ---------------------------------------------------------------------------
// Schemas (1:1 with commands.ts / workload.ts / common.ts)

// Regular expressions shared with the TypeScript contracts.
const (
	ReUUID = `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`
	reIPv4 = `^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$`
	reIPv6 = `^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$`
	// ReImageRef is the image reference shape check from workload.ts (authorisation is the allowlist).
	ReImageRef = `^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`
	ReEnvKey   = `^[A-Za-z_][A-Za-z0-9_]{0,127}$`
)

var (
	reUUIDCompiled  = regexp.MustCompile(ReUUID)
	reAbsOrDrive    = regexp.MustCompile(`^([/\\]|[a-zA-Z]:)`)
	reSegmentSplit  = regexp.MustCompile(`[/\\]`)
	gib             = float64(1 << 30)
	mib             = float64(1 << 20)
	uuidSchema      = Str().Regex(ReUUID)
	bytesSchema     = Int().Min(0)
	denylistSchema  = Optional(Arr(Str().Max(512), -1, 256))
	portSchema      = Int().Min(1).Max(65535)
	argSchema       = Str().Min(1).Max(4096).Regex(`^[^\x00\r\n]*$`)
	relativePath    = Str().Max(1024).Refine(refineNoNUL).Refine(refineRelative).Refine(refineNoDotDot)
	mutableRelative = relativePath.Refine(func(p string) string {
		if IsRootPath(p) {
			return "must not target the data root"
		}
		return ""
	})
)

// zipEntryName mirrors ZipEntryName in commands.ts.
var zipEntryName = Str().Min(1).Max(255).Refine(func(n string) string {
	for _, r := range n {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) || r == '\\' {
			return "no control characters or backslashes"
		}
	}
	return ""
}).Refine(func(n string) string {
	if strings.HasPrefix(n, "/") {
		return "must be relative"
	}
	return ""
}).Refine(func(n string) string {
	for _, seg := range strings.Split(n, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "no empty, '.' or '..' segments"
		}
	}
	return ""
})

// IsUUID reports whether s matches zod's z.uuid() pattern.
func IsUUID(s string) bool { return reUUIDCompiled.MatchString(s) }

func refineNoNUL(p string) string {
	if strings.Contains(p, "\x00") {
		return "NUL byte"
	}
	return ""
}

func refineRelative(p string) string {
	if reAbsOrDrive.MatchString(p) {
		return "must be relative"
	}
	return ""
}

func refineNoDotDot(p string) string {
	for _, seg := range reSegmentSplit.Split(p, -1) {
		if seg == ".." {
			return "must not contain '..'"
		}
	}
	return ""
}

// IsRootPath mirrors isRootPath in commands.ts: every segment is "" or ".".
func IsRootPath(p string) bool {
	for _, seg := range reSegmentSplit.Split(p, -1) {
		if seg != "" && seg != "." {
			return false
		}
	}
	return true
}

func strEmptyMap() any          { return map[string]any{} }
func emptyArr() any             { return []any{} }
func constAny(v any) func() any { return func() any { return v } }

var workloadRef = Obj(F("workloadId", uuidSchema))

// denyRef is WorkloadRef + the optional template denylist (commands.ts DenyRef).
var denyRef = workloadRef.Extend(F("denylist", denylistSchema))

var portBindingSchema = Obj(
	F("containerPort", portSchema),
	F("hostPort", portSchema),
	F("hostIp", Default(Str().OneOfRegex(reIPv4, reIPv6), constAny("0.0.0.0"))),
	F("protocol", Default(Str().Enum("tcp", "udp"), constAny("tcp"))),
)

var workloadNetworkSchema = Obj(
	F("name", Str().Regex(`^bf-[a-z0-9-]{1,60}$`)),
	F("aliases", Default(Arr(Str().Regex(`^[a-z0-9][a-z0-9-]{0,62}$`), -1, -1), emptyArr)),
)

var restartPolicySchema = Obj(
	F("mode", Str().Enum("never", "on-failure", "always")),
	F("maxRetries", Default(Int().Min(0).Max(100), constAny(int64(3)))),
	F("backoffMs", Default(Int().Min(1000).Max(600_000), constAny(int64(10_000)))),
)

// WorkloadSpecSchema mirrors WorkloadSpec in workload.ts.
var workloadStopSchema = Union("type", map[string]*ObjectSchema{
	"command": Obj(F("type", Str()), F("command", Str().Min(1).Max(256).Regex(`^[^\x00\r\n]*$`))),
	"signal":  Obj(F("type", Str()), F("signal", Str().Enum("SIGINT", "SIGTERM", "SIGQUIT", "SIGKILL"))),
})

var envSchema = Default(Record(Str().Regex(ReEnvKey), Str().Max(16*1024)), strEmptyMap)

// isValidWorkloadSpec from workload.ts: "argv" workloads need a command.
func isValidWorkloadSpec(v any) (string, string) {
	m, _ := v.(map[string]any)
	cmd, _ := m["command"].([]any)
	if m["entrypoint"] == EntrypointArgv && len(cmd) == 0 {
		return "command", `required when entrypoint is "argv"`
	}
	return "", ""
}

var WorkloadSpecSchema = RefineObj(Obj(
	F("workloadId", uuidSchema),
	F("kind", Str().Enum("minecraft", "velocity", "generic")),
	F("image", Str().Max(255).Regex(ReImageRef)),
	F("entrypoint", Default(Str().Enum(EntrypointArgv, EntrypointImage), constAny(EntrypointArgv))),
	F("command", Arr(argSchema, -1, 256)),
	F("env", envSchema),
	F("dataMountPath", Default(Str().Enum("/data", "/home/container"), constAny("/data"))),
	F("readOnlyRootfs", Default(Bool(), constAny(true))),
	F("memoryLimitBytes", bytesSchema.Min(128*1024*1024)),
	F("cpuLimitMillicores", Nullable(Int().Min(100).Max(1_024_000))),
	F("pidsLimit", Default(Int().Min(64).Max(65536), constAny(int64(4096)))),
	F("ports", Default(Arr(portBindingSchema, -1, 16), emptyArr)),
	F("networks", Default(Arr(workloadNetworkSchema, -1, 8), emptyArr)),
	F("stop", Nullable(workloadStopSchema)),
	F("stopTimeoutMs", Default(Int().Min(1000).Max(600_000), constAny(int64(60_000)))),
	F("restartPolicy", restartPolicySchema),
	F("jvmProbe", Default(Bool(), constAny(true))),
	F("labels", Default(Record(Str().Regex(`^[a-z0-9.\-/]{1,128}$`), Str().Max(256)), strEmptyMap)),
), isValidWorkloadSpec)

var checksumSchema = Obj(
	F("algorithm", Str().Enum("sha1", "sha256", "sha512")),
	F("value", Str().Regex(`^[a-f0-9]{40,128}$`)),
)

// CommandDef describes one entry of the command catalogue.
type CommandDef struct {
	Schema Schema
	New    func() any
	// Mutating commands are serialised per workload.
	Mutating bool
}

// Commands is the command catalogue known to this agent.
var Commands = map[string]CommandDef{
	CmdNodeFacts: {Schema: Obj(), New: func() any { return &EmptyPayload{} }},
	CmdNodePorts: {Schema: Obj(), New: func() any { return &EmptyPayload{} }},
	// Not Mutating: an install in flight answers another install/start with BUSY instead of queueing.
	CmdWorkloadInstall: {Schema: workloadRef.Extend(
		F("image", Str().Min(1).Max(255)),
		F("entrypoint", Str().Enum("bash", "ash", "sh")),
		F("script", Str().Max(64*1024)),
		F("env", envSchema),
		F("memoryLimitBytes", bytesSchema.Min(128*1024*1024)),
		F("cpuLimitMillicores", Nullable(Int().Min(100))),
		F("timeoutMs", Default(Int().Min(60_000).Max(3*3600_000), constAny(int64(30*60_000)))),
	), New: func() any { return &WorkloadInstallPayload{} }},
	CmdFsCopy: {Schema: denyRef.Extend(F("path", mutableRelative)),
		New: func() any { return &FsPathPayload{} }, Mutating: true},
	CmdFsCompress: {Schema: denyRef.Extend(
		F("root", relativePath),
		F("paths", Arr(mutableRelative, 1, 1000)),
		F("format", Str().Enum("tar.gz", "zip")),
		F("destPath", Optional(mutableRelative)),
		F("maxTotalBytes", bytesSchema.Max(64*gib)),
	), New: func() any { return &FsCompressPayload{} }, Mutating: true},
	CmdFsChmod: {Schema: denyRef.Extend(F("path", mutableRelative), F("mode", Int().Min(0).Max(0o777))),
		New: func() any { return &FsChmodPayload{} }, Mutating: true},
	CmdFsFind: {Schema: workloadRef.Extend(
		F("path", relativePath),
		F("query", Str().Min(1).Max(64)),
		F("maxResults", Default(Int().Min(1).Max(500), constAny(int64(100)))),
	), New: func() any { return &FsFindPayload{} }},
	CmdNodeProbe: {Schema: Obj(
		F("host", Str().Min(1).Max(253)),
		F("port", portSchema),
		F("kind", Str().Enum("tcp", "minecraft")),
		F("timeoutMs", Default(Int().Min(100).Max(30_000), constAny(int64(3000)))),
	), New: func() any { return &NodeProbePayload{} }},
	CmdWorkloadEnsure: {Schema: WorkloadSpecSchema, New: func() any { return &WorkloadSpec{} }, Mutating: true},
	CmdWorkloadStart:  {Schema: workloadRef, New: func() any { return &WorkloadRef{} }, Mutating: true},
	CmdWorkloadStop: {Schema: workloadRef.Extend(
		F("timeoutMs", Default(Int().Min(1000).Max(600_000), constAny(int64(60_000)))),
	), New: func() any { return &WorkloadStopPayload{} }, Mutating: true},
	// kill deliberately bypasses per-workload serialisation so it can pre-empt a hanging stop.
	CmdWorkloadKill: {Schema: workloadRef, New: func() any { return &WorkloadRef{} }},
	CmdWorkloadRemove: {Schema: workloadRef.Extend(F("deleteData", Bool())),
		New: func() any { return &WorkloadRemovePayload{} }, Mutating: true},
	CmdWorkloadStatus: {Schema: Obj(F("workloadId", Optional(uuidSchema))),
		New: func() any { return &WorkloadStatusPayload{} }},
	CmdWorkloadConsole: {Schema: workloadRef.Extend(
		F("line", Str().Min(1).Max(1024).Regex(`^[^\x00\r\n]*$`)),
	), New: func() any { return &WorkloadConsolePayload{} }},
	CmdWorkloadLogsTail: {Schema: workloadRef.Extend(
		F("lines", Default(Int().Min(1).Max(5000), constAny(int64(500)))),
		F("sinceTs", Optional(Int().Min(0))),
	), New: func() any { return &WorkloadLogsTailPayload{} }},
	CmdFsList: {Schema: workloadRef.Extend(F("path", relativePath)), New: func() any { return &FsPathPayload{} }},
	CmdFsStat: {Schema: workloadRef.Extend(F("path", relativePath)), New: func() any { return &FsPathPayload{} }},
	CmdFsRead: {Schema: denyRef.Extend(
		F("path", relativePath),
		F("maxBytes", Int().Min(1).Max(5*mib)),
	), New: func() any { return &FsReadPayload{} }},
	CmdFsWrite: {Schema: denyRef.Extend(
		F("path", mutableRelative),
		F("content", Str().Max(7*1024*1024)),
		F("encoding", Str().Enum("utf8", "base64")),
		F("ifMatchSha256", Optional(Nullable(Str()))),
		F("createParents", Default(Bool(), constAny(false))),
	), New: func() any { return &FsWritePayload{} }, Mutating: true},
	CmdFsMkdir: {Schema: denyRef.Extend(F("path", mutableRelative)),
		New: func() any { return &FsPathPayload{} }, Mutating: true},
	CmdFsRename: {Schema: denyRef.Extend(F("from", mutableRelative), F("to", mutableRelative)),
		New: func() any { return &FsRenamePayload{} }, Mutating: true},
	CmdFsDelete: {Schema: denyRef.Extend(F("path", mutableRelative), F("recursive", Bool())),
		New: func() any { return &FsDeletePayload{} }, Mutating: true},
	CmdFsDu: {Schema: workloadRef.Extend(
		F("path", relativePath),
		F("depth", Default(Int().Min(0).Max(3), constAny(int64(1)))),
		F("top", Default(Int().Min(1).Max(50), constAny(int64(20)))),
	), New: func() any { return &FsDuPayload{} }},
	CmdFsExtract: {Schema: denyRef.Extend(
		F("archivePath", mutableRelative),
		F("destPath", relativePath),
		F("maxTotalBytes", bytesSchema.Max(64*gib)),
		F("maxEntries", Int().Min(1).Max(1_000_000)),
	), New: func() any { return &FsExtractPayload{} }, Mutating: true},
	CmdFsTransferPush: {Schema: denyRef.Extend(F("path", mutableRelative), F("transferId", uuidSchema)),
		New: func() any { return &FsTransferPushPayload{} }},
	CmdFsTransferPull: {Schema: denyRef.Extend(
		F("path", mutableRelative), F("transferId", uuidSchema), F("maxBytes", bytesSchema),
	), New: func() any { return &FsTransferPullPayload{} }, Mutating: true},
	CmdArtifactFetch: {Schema: workloadRef.Extend(
		F("url", Str().HTTPSURL()),
		F("destPath", mutableRelative),
		F("checksum", Nullable(checksumSchema)),
		F("maxBytes", bytesSchema.Max(2*gib)),
		F("cache", Default(Bool(), constAny(true))),
	), New: func() any { return &ArtifactFetchPayload{} }, Mutating: true},
	CmdCredentialsRotate: {Schema: Obj(), New: func() any { return &EmptyPayload{} }},
	// Backups are not Mutating: exclusivity is handled by the driver's per-workload claims (a backup
	// may run next to a running server; restore/install need it stopped).
	CmdBackupCreate: {Schema: workloadRef.Extend(
		F("backupId", uuidSchema),
		F("ignore", Default(Arr(Str().Max(512), -1, 100), emptyArr)),
		F("maxBytes", bytesSchema.Max(512*gib)),
	), New: func() any { return &BackupCreatePayload{} }},
	CmdBackupUpload: {Schema: workloadRef.Extend(
		F("backupId", uuidSchema),
		F("partSize", Int().Min(5*mib).Max(5*gib)),
		F("parts", Arr(Obj(F("partNumber", Int().Min(1).Max(10_000)), F("url", Str().HTTPSURL())), 1, 10_000)),
		F("deleteLocal", Default(Bool(), constAny(true))),
	), New: func() any { return &BackupUploadPayload{} }},
	CmdBackupRestore: {Schema: workloadRef.Extend(
		F("backupId", uuidSchema),
		F("source", Union("type", map[string]*ObjectSchema{
			"local": Obj(F("type", Str())),
			"url":   Obj(F("type", Str()), F("url", Str().HTTPSURL())),
		})),
		F("sha256", Str().Regex(`^[a-f0-9]{64}$`)),
		F("truncate", Bool()),
		F("maxTotalBytes", bytesSchema.Max(512*gib)),
	), New: func() any { return &BackupRestorePayload{} }},
	CmdBackupDelete: {Schema: workloadRef.Extend(F("backupId", uuidSchema)), New: func() any { return &BackupRefPayload{} }},
	CmdBackupTransferPush: {Schema: workloadRef.Extend(F("backupId", uuidSchema), F("transferId", uuidSchema)),
		New: func() any { return &BackupTransferPushPayload{} }},
	// Extension scans are read-only and take no claim: they run next to a running server.
	CmdFsHash: {Schema: denyRef.Extend(
		F("paths", Arr(relativePath, 1, 512)),
		F("algorithms", Arr(Str().Enum("sha1", "sha256", "sha512"), 1, 3).Unique("duplicate algorithm")),
		F("maxBytesPerFile", bytesSchema.Min(1).Max(2*gib)),
		F("maxTotalBytes", Default(bytesSchema.Min(1).Max(64*gib), constAny(int64(16<<30)))),
	), New: func() any { return &FsHashPayload{} }},
	CmdJarReadEntries: {Schema: denyRef.Extend(
		F("paths", Arr(relativePath, 1, 256)),
		F("entries", Arr(zipEntryName, 1, 32).Unique("duplicate entry name")),
		F("maxEntryBytes", Int().Min(64).Max(JarMaxEntryBytes)),
		F("maxJarBytes", bytesSchema.Min(1).Max(2*gib)),
		F("maxTotalBytes", Default(Int().Min(1).Max(JarMaxTotalBytes), constAny(int64(4<<20)))),
		F("hash", Default(Arr(Str().Enum("sha1", "sha512"), -1, 2).Unique("duplicate algorithm"), emptyArr)),
	), New: func() any { return &JarReadEntriesPayload{} }},
}

// ParsePayload validates a payload for a known command type. ok=false means the type is unknown.
func ParsePayload(cmdType string, raw json.RawMessage) (payload any, known bool, perr *Error) {
	def, ok := Commands[cmdType]
	if !ok {
		return nil, false, nil
	}
	out := def.New()
	if err := Validate(def.Schema, raw, out); err != nil {
		return nil, true, err
	}
	return out, true, nil
}

// WorkloadIDOf extracts the workloadId from a typed payload, if any.
func WorkloadIDOf(p any) string {
	switch v := p.(type) {
	case *WorkloadSpec:
		return v.WorkloadID
	case *WorkloadRef:
		return v.WorkloadID
	case *WorkloadStopPayload:
		return v.WorkloadID
	case *WorkloadRemovePayload:
		return v.WorkloadID
	case *WorkloadStatusPayload:
		return v.WorkloadID
	case *WorkloadConsolePayload:
		return v.WorkloadID
	case *WorkloadLogsTailPayload:
		return v.WorkloadID
	case *FsPathPayload:
		return v.WorkloadID
	case *FsReadPayload:
		return v.WorkloadID
	case *FsWritePayload:
		return v.WorkloadID
	case *FsRenamePayload:
		return v.WorkloadID
	case *FsDeletePayload:
		return v.WorkloadID
	case *FsDuPayload:
		return v.WorkloadID
	case *FsExtractPayload:
		return v.WorkloadID
	case *FsTransferPushPayload:
		return v.WorkloadID
	case *FsTransferPullPayload:
		return v.WorkloadID
	case *ArtifactFetchPayload:
		return v.WorkloadID
	case *WorkloadInstallPayload:
		return v.WorkloadID
	case *FsCompressPayload:
		return v.WorkloadID
	case *FsChmodPayload:
		return v.WorkloadID
	case *FsFindPayload:
		return v.WorkloadID
	case *BackupCreatePayload:
		return v.WorkloadID
	case *BackupUploadPayload:
		return v.WorkloadID
	case *BackupRestorePayload:
		return v.WorkloadID
	case *BackupRefPayload:
		return v.WorkloadID
	case *BackupTransferPushPayload:
		return v.WorkloadID
	case *FsHashPayload:
		return v.WorkloadID
	case *JarReadEntriesPayload:
		return v.WorkloadID
	}
	return ""
}
