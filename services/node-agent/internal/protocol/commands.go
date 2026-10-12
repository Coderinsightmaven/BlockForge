package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Command types (AGENT_COMMANDS keys in commands.ts).
const (
	CmdNodeFacts         = "node.facts"
	CmdNodeProbe         = "node.probe"
	CmdWorkloadEnsure    = "workload.ensure"
	CmdWorkloadStart     = "workload.start"
	CmdWorkloadStop      = "workload.stop"
	CmdWorkloadKill      = "workload.kill"
	CmdWorkloadRemove    = "workload.remove"
	CmdWorkloadStatus    = "workload.status"
	CmdWorkloadConsole   = "workload.console"
	CmdWorkloadLogsTail  = "workload.logs.tail"
	CmdFsList            = "fs.list"
	CmdFsStat            = "fs.stat"
	CmdFsRead            = "fs.read"
	CmdFsWrite           = "fs.write"
	CmdFsMkdir           = "fs.mkdir"
	CmdFsRename          = "fs.rename"
	CmdFsDelete          = "fs.delete"
	CmdFsDu              = "fs.du"
	CmdFsExtract         = "fs.extract"
	CmdFsTransferPush    = "fs.transfer.push"
	CmdFsTransferPull    = "fs.transfer.pull"
	CmdArtifactFetch     = "artifact.fetch"
	CmdCredentialsRotate = "credentials.rotate"
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

// WorkloadSpec is the payload of workload.ensure (workload.ts WorkloadSpec).
type WorkloadSpec struct {
	WorkloadID         string            `json:"workloadId"`
	Kind               string            `json:"kind"`
	Image              string            `json:"image"`
	Command            []string          `json:"command"`
	Env                map[string]string `json:"env"`
	MemoryLimitBytes   int64             `json:"memoryLimitBytes"`
	CPULimitMillicores *int64            `json:"cpuLimitMillicores"`
	PidsLimit          int64             `json:"pidsLimit"`
	Ports              []PortBinding     `json:"ports"`
	Networks           []WorkloadNetwork `json:"networks"`
	StopCommand        *string           `json:"stopCommand"`
	StopTimeoutMs      int64             `json:"stopTimeoutMs"`
	RestartPolicy      RestartPolicy     `json:"restartPolicy"`
	JvmProbe           bool              `json:"jvmProbe"`
	Labels             map[string]string `json:"labels"`
}

type WorkloadRef struct {
	WorkloadID string `json:"workloadId"`
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
	Path       string `json:"path"`
}

type FsReadPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	MaxBytes   int64  `json:"maxBytes"`
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
	WorkloadID    string                 `json:"workloadId"`
	Path          string                 `json:"path"`
	Content       string                 `json:"content"`
	Encoding      string                 `json:"encoding"`
	IfMatchSha256 OptionalNullableString `json:"ifMatchSha256"`
	CreateParents bool                   `json:"createParents"`
}

type FsRenamePayload struct {
	WorkloadID string `json:"workloadId"`
	From       string `json:"from"`
	To         string `json:"to"`
}

type FsDeletePayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	Recursive  bool   `json:"recursive"`
}

type FsDuPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	Depth      int    `json:"depth"`
	Top        int    `json:"top"`
}

type FsExtractPayload struct {
	WorkloadID    string `json:"workloadId"`
	ArchivePath   string `json:"archivePath"`
	DestPath      string `json:"destPath"`
	MaxTotalBytes int64  `json:"maxTotalBytes"`
	MaxEntries    int64  `json:"maxEntries"`
}

type FsTransferPushPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	TransferID string `json:"transferId"`
}

type FsTransferPullPayload struct {
	WorkloadID string `json:"workloadId"`
	Path       string `json:"path"`
	TransferID string `json:"transferId"`
	MaxBytes   int64  `json:"maxBytes"`
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
	ReEnvKey   = `^[A-Z][A-Z0-9_]{0,63}$`
)

var (
	reUUIDCompiled  = regexp.MustCompile(ReUUID)
	reAbsOrDrive    = regexp.MustCompile(`^([/\\]|[a-zA-Z]:)`)
	reSegmentSplit  = regexp.MustCompile(`[/\\]`)
	gib             = float64(1 << 30)
	mib             = float64(1 << 20)
	uuidSchema      = Str().Regex(ReUUID)
	bytesSchema     = Int().Min(0)
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
var WorkloadSpecSchema = Obj(
	F("workloadId", uuidSchema),
	F("kind", Str().Enum("minecraft", "velocity")),
	F("image", Str().Max(255).Regex(ReImageRef)),
	F("command", Arr(argSchema, 1, 256)),
	F("env", Default(Record(Str().Regex(ReEnvKey), Str().Max(4096)), strEmptyMap)),
	F("memoryLimitBytes", bytesSchema.Min(128*1024*1024)),
	F("cpuLimitMillicores", Nullable(Int().Min(100).Max(1_024_000))),
	F("pidsLimit", Default(Int().Min(64).Max(65536), constAny(int64(4096)))),
	F("ports", Default(Arr(portBindingSchema, -1, 16), emptyArr)),
	F("networks", Default(Arr(workloadNetworkSchema, -1, 8), emptyArr)),
	F("stopCommand", Nullable(Str().Enum("stop", "end", "shutdown"))),
	F("stopTimeoutMs", Default(Int().Min(1000).Max(600_000), constAny(int64(60_000)))),
	F("restartPolicy", restartPolicySchema),
	F("jvmProbe", Default(Bool(), constAny(true))),
	F("labels", Default(Record(Str().Regex(`^[a-z0-9.\-/]{1,128}$`), Str().Max(256)), strEmptyMap)),
)

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
	CmdFsRead: {Schema: workloadRef.Extend(
		F("path", relativePath),
		F("maxBytes", Int().Min(1).Max(5*mib)),
	), New: func() any { return &FsReadPayload{} }},
	CmdFsWrite: {Schema: workloadRef.Extend(
		F("path", mutableRelative),
		F("content", Str().Max(7*1024*1024)),
		F("encoding", Str().Enum("utf8", "base64")),
		F("ifMatchSha256", Optional(Nullable(Str()))),
		F("createParents", Default(Bool(), constAny(false))),
	), New: func() any { return &FsWritePayload{} }, Mutating: true},
	CmdFsMkdir: {Schema: workloadRef.Extend(F("path", mutableRelative)),
		New: func() any { return &FsPathPayload{} }, Mutating: true},
	CmdFsRename: {Schema: workloadRef.Extend(F("from", mutableRelative), F("to", mutableRelative)),
		New: func() any { return &FsRenamePayload{} }, Mutating: true},
	CmdFsDelete: {Schema: workloadRef.Extend(F("path", mutableRelative), F("recursive", Bool())),
		New: func() any { return &FsDeletePayload{} }, Mutating: true},
	CmdFsDu: {Schema: workloadRef.Extend(
		F("path", relativePath),
		F("depth", Default(Int().Min(0).Max(3), constAny(int64(1)))),
		F("top", Default(Int().Min(1).Max(50), constAny(int64(20)))),
	), New: func() any { return &FsDuPayload{} }},
	CmdFsExtract: {Schema: workloadRef.Extend(
		F("archivePath", mutableRelative),
		F("destPath", relativePath),
		F("maxTotalBytes", bytesSchema.Max(64*gib)),
		F("maxEntries", Int().Min(1).Max(1_000_000)),
	), New: func() any { return &FsExtractPayload{} }, Mutating: true},
	CmdFsTransferPush: {Schema: workloadRef.Extend(F("path", mutableRelative), F("transferId", uuidSchema)),
		New: func() any { return &FsTransferPushPayload{} }},
	CmdFsTransferPull: {Schema: workloadRef.Extend(
		F("path", mutableRelative), F("transferId", uuidSchema), F("maxBytes", bytesSchema),
	), New: func() any { return &FsTransferPullPayload{} }, Mutating: true},
	CmdArtifactFetch: {Schema: workloadRef.Extend(
		F("url", Str().HTTPSURL()),
		F("destPath", mutableRelative),
		F("checksum", Nullable(checksumSchema)),
		F("maxBytes", bytesSchema.Max(2*gib)),
	), New: func() any { return &ArtifactFetchPayload{} }, Mutating: true},
	CmdCredentialsRotate: {Schema: Obj(), New: func() any { return &EmptyPayload{} }},
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
	}
	return ""
}
