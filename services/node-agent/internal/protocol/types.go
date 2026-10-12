// Package protocol mirrors packages/contracts/src/agent/*.ts (agent protocol v1).
//
// Field names and JSON shapes must match the zod schemas exactly; the golden fixtures in
// packages/contracts/fixtures/agent are loaded by the tests in this package. Optional fields are
// pointers (or omitempty strings) so that a legitimately-zero value is still emitted while an
// unavailable value is omitted, never zero-filled.
package protocol

import "encoding/json"

// Protocol constants shared with the control plane (envelope.ts).
const (
	ProtocolVersion     = 1
	TokenAudience       = "blockforge-control-plane"
	AuthScheme          = "BFAgent"
	RotationProofPrefix = "blockforge-rotate:"

	TokenMaxLifetimeMs   = 120_000
	TokenClockSkewMs     = 30_000
	CommandMaxLifetimeMs = 900_000
	CommandExpiryGraceMs = 30_000
	// CommandClockSkewMs bounds how far issuedAt may be ahead of the agent clock.
	CommandClockSkewMs = 30_000
	ResultCacheMs      = 900_000
	MaxFrameBytes      = 16 * 1024 * 1024
	LogLineMaxBytes    = 8192
	LogLinesPerSecond  = 200
	LogBurstLines      = 2000
)

// InsecureHTTPAllowedHosts are the only hosts reachable over plain HTTP with --insecure-allow-http.
var InsecureHTTPAllowedHosts = []string{"localhost", "127.0.0.1", "::1", "host.docker.internal"}

// ---------------------------------------------------------------------------
// Facts (facts.ts)

type NetworkInterfaceFact struct {
	Name      string   `json:"name"`
	MAC       string   `json:"mac,omitempty"`
	MTU       *int     `json:"mtu,omitempty"`
	Addresses []string `json:"addresses"`
	Up        *bool    `json:"up,omitempty"`
}

type FilesystemFact struct {
	Mount      string `json:"mount"`
	Device     string `json:"device,omitempty"`
	FsType     string `json:"fsType,omitempty"`
	TotalBytes int64  `json:"totalBytes"`
}

type ContainerRuntimeFact struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	APIVersion    string `json:"apiVersion,omitempty"`
	Rootless      bool   `json:"rootless"`
	CgroupVersion string `json:"cgroupVersion,omitempty"`
	StorageDriver string `json:"storageDriver,omitempty"`
	Healthy       bool   `json:"healthy"`
	Error         string `json:"error,omitempty"`
}

type JavaRuntimeFact struct {
	Major   int    `json:"major"`
	Version string `json:"version"`
	Vendor  string `json:"vendor,omitempty"`
	Source  string `json:"source"`
	Ref     string `json:"ref"`
}

type NodeFacts struct {
	Hostname         string                 `json:"hostname"`
	OS               string                 `json:"os"`
	Platform         string                 `json:"platform,omitempty"`
	PlatformVersion  string                 `json:"platformVersion,omitempty"`
	KernelVersion    string                 `json:"kernelVersion,omitempty"`
	Arch             string                 `json:"arch"`
	CPUModel         string                 `json:"cpuModel,omitempty"`
	CPUPhysicalCores *int                   `json:"cpuPhysicalCores,omitempty"`
	CPULogicalCores  int                    `json:"cpuLogicalCores"`
	MemoryTotalBytes int64                  `json:"memoryTotalBytes"`
	SwapTotalBytes   *int64                 `json:"swapTotalBytes,omitempty"`
	BootTime         *int64                 `json:"bootTime,omitempty"`
	Timezone         string                 `json:"timezone,omitempty"`
	DataRoot         string                 `json:"dataRoot"`
	Interfaces       []NetworkInterfaceFact `json:"interfaces"`
	Filesystems      []FilesystemFact       `json:"filesystems"`
	ContainerRuntime *ContainerRuntimeFact  `json:"containerRuntime"`
	JavaRuntimes     []JavaRuntimeFact      `json:"javaRuntimes"`
}

// ---------------------------------------------------------------------------
// Metrics (metrics.ts)

type CPUSample struct {
	UsagePct   float64   `json:"usagePct"`
	PerCorePct []float64 `json:"perCorePct,omitempty"`
	Load1      *float64  `json:"load1,omitempty"`
	Load5      *float64  `json:"load5,omitempty"`
	Load15     *float64  `json:"load15,omitempty"`
	IowaitPct  *float64  `json:"iowaitPct,omitempty"`
	StealPct   *float64  `json:"stealPct,omitempty"`
}

type MemorySample struct {
	TotalBytes     int64  `json:"totalBytes"`
	UsedBytes      int64  `json:"usedBytes"`
	AvailableBytes int64  `json:"availableBytes"`
	CachedBytes    *int64 `json:"cachedBytes,omitempty"`
	BuffersBytes   *int64 `json:"buffersBytes,omitempty"`
	SwapTotalBytes *int64 `json:"swapTotalBytes,omitempty"`
	SwapUsedBytes  *int64 `json:"swapUsedBytes,omitempty"`
}

type FilesystemSample struct {
	Mount       string `json:"mount"`
	Device      string `json:"device,omitempty"`
	FsType      string `json:"fsType,omitempty"`
	TotalBytes  int64  `json:"totalBytes"`
	UsedBytes   int64  `json:"usedBytes"`
	FreeBytes   int64  `json:"freeBytes"`
	InodesTotal *int64 `json:"inodesTotal,omitempty"`
	InodesUsed  *int64 `json:"inodesUsed,omitempty"`
}

type DiskIOSample struct {
	Device           string   `json:"device"`
	ReadBytesPerSec  float64  `json:"readBytesPerSec"`
	WriteBytesPerSec float64  `json:"writeBytesPerSec"`
	ReadOpsPerSec    float64  `json:"readOpsPerSec"`
	WriteOpsPerSec   float64  `json:"writeOpsPerSec"`
	BusyPct          *float64 `json:"busyPct,omitempty"`
	AvgLatencyMs     *float64 `json:"avgLatencyMs,omitempty"`
}

type NetworkSample struct {
	Iface           string   `json:"iface"`
	RxBytesPerSec   float64  `json:"rxBytesPerSec"`
	TxBytesPerSec   float64  `json:"txBytesPerSec"`
	RxPacketsPerSec *float64 `json:"rxPacketsPerSec,omitempty"`
	TxPacketsPerSec *float64 `json:"txPacketsPerSec,omitempty"`
	RxErrorsTotal   *uint64  `json:"rxErrorsTotal,omitempty"`
	TxErrorsTotal   *uint64  `json:"txErrorsTotal,omitempty"`
	RxDroppedTotal  *uint64  `json:"rxDroppedTotal,omitempty"`
	TxDroppedTotal  *uint64  `json:"txDroppedTotal,omitempty"`
}

type TCPSample struct {
	Established int64 `json:"established"`
	Total       int64 `json:"total"`
}

type NodeMetricSample struct {
	TS          int64              `json:"ts"`
	CPU         CPUSample          `json:"cpu"`
	Memory      MemorySample       `json:"memory"`
	Filesystems []FilesystemSample `json:"filesystems"`
	DiskIO      []DiskIOSample     `json:"diskIo"`
	Network     []NetworkSample    `json:"network"`
	TCP         *TCPSample         `json:"tcp,omitempty"`
}

type JvmStats struct {
	HeapUsedBytes      int64  `json:"heapUsedBytes"`
	HeapCommittedBytes int64  `json:"heapCommittedBytes"`
	HeapMaxBytes       int64  `json:"heapMaxBytes"`
	NonHeapUsedBytes   *int64 `json:"nonHeapUsedBytes,omitempty"`
	GcCountTotal       *int64 `json:"gcCountTotal,omitempty"`
	GcTimeMsTotal      *int64 `json:"gcTimeMsTotal,omitempty"`
	Threads            *int64 `json:"threads,omitempty"`
	UptimeMs           *int64 `json:"uptimeMs,omitempty"`
	SampledAt          int64  `json:"sampledAt"`
}

type SlpPlayer struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type SlpStatus struct {
	VersionName   string      `json:"versionName,omitempty"`
	Protocol      *int        `json:"protocol,omitempty"`
	PlayersOnline int         `json:"playersOnline"`
	PlayersMax    int         `json:"playersMax"`
	PlayerSample  []SlpPlayer `json:"playerSample"`
	Motd          string      `json:"motd,omitempty"`
	LatencyMs     float64     `json:"latencyMs"`
}

type WorkloadMetricSample struct {
	WorkloadID               string     `json:"workloadId"`
	TS                       int64      `json:"ts"`
	Running                  bool       `json:"running"`
	CPUPct                   *float64   `json:"cpuPct,omitempty"`
	CPUThrottledPeriodsTotal *uint64    `json:"cpuThrottledPeriodsTotal,omitempty"`
	MemoryUsageBytes         *int64     `json:"memoryUsageBytes,omitempty"`
	MemoryLimitBytes         *int64     `json:"memoryLimitBytes,omitempty"`
	MemoryCacheBytes         *int64     `json:"memoryCacheBytes,omitempty"`
	NetRxBytesPerSec         *float64   `json:"netRxBytesPerSec,omitempty"`
	NetTxBytesPerSec         *float64   `json:"netTxBytesPerSec,omitempty"`
	BlkReadBytesPerSec       *float64   `json:"blkReadBytesPerSec,omitempty"`
	BlkWriteBytesPerSec      *float64   `json:"blkWriteBytesPerSec,omitempty"`
	Pids                     *int64     `json:"pids,omitempty"`
	DiskUsageBytes           *int64     `json:"diskUsageBytes,omitempty"`
	JVM                      *JvmStats  `json:"jvm,omitempty"`
	Minecraft                *SlpStatus `json:"minecraft,omitempty"`
}

// ---------------------------------------------------------------------------
// Workloads (workload.ts)

// Workload runtime states.
const (
	StateCreated    = "created"
	StateRunning    = "running"
	StateRestarting = "restarting"
	StateExited     = "exited"
	StateDead       = "dead"
	StateMissing    = "missing"
)

type WorkloadStatus struct {
	WorkloadID   string `json:"workloadId"`
	Exists       bool   `json:"exists"`
	State        string `json:"state"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	OOMKilled    *bool  `json:"oomKilled,omitempty"`
	StartedAt    *int64 `json:"startedAt,omitempty"`
	FinishedAt   *int64 `json:"finishedAt,omitempty"`
	RestartCount int    `json:"restartCount"`
	Image        string `json:"image,omitempty"`
	ContainerID  string `json:"containerId,omitempty"`
	SpecHash     string `json:"specHash,omitempty"`
}

type LogLine struct {
	TS     int64  `json:"ts"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

type FileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	ModifiedAt int64  `json:"modifiedAt"`
	Mode       string `json:"mode,omitempty"`
}

// ---------------------------------------------------------------------------
// Enrollment + auth (envelope.ts)

type EnrollRequest struct {
	Token           string    `json:"token"`
	PublicKey       string    `json:"publicKey"`
	AgentVersion    string    `json:"agentVersion"`
	ProtocolVersion int       `json:"protocolVersion"`
	Facts           NodeFacts `json:"facts"`
	NodeName        string    `json:"nodeName,omitempty"`
}

type EnrollResponse struct {
	NodeID                 string `json:"nodeId"`
	Approved               bool   `json:"approved"`
	ControlPlaneSigningKey string `json:"controlPlaneSigningKey"`
	HeartbeatIntervalMs    int64  `json:"heartbeatIntervalMs"`
	MetricsIntervalMs      int64  `json:"metricsIntervalMs"`
}

type AgentTokenClaims struct {
	Nid string `json:"nid"`
	Aud string `json:"aud"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
	Jti string `json:"jti"`
}

// ---------------------------------------------------------------------------
// Frames

// Frame type discriminators.
const (
	FrameCmd       = "cmd"
	FrameWelcome   = "welcome"
	FrameHello     = "hello"
	FrameHeartbeat = "heartbeat"
	FrameProgress  = "progress"
	FrameResult    = "result"
	FrameMetrics   = "metrics"
	FrameEvent     = "event"
	FrameLogs      = "logs"
)

// Event names for `event` frames.
const (
	EventWorkloadState = "workload.state"
	EventWorkloadOOM   = "workload.oom"
	EventAgentWarning  = "agent.warning"
)

type CommandFrame struct {
	T    string `json:"t"`
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

type WelcomeFrame struct {
	T                   string `json:"t"`
	NodeID              string `json:"nodeId"`
	ServerTime          int64  `json:"serverTime"`
	Approved            bool   `json:"approved"`
	HeartbeatIntervalMs int64  `json:"heartbeatIntervalMs"`
	MetricsIntervalMs   int64  `json:"metricsIntervalMs"`
}

// CommandBody is the signed JSON document inside CommandFrame.Body.
type CommandBody struct {
	ID        string          `json:"id"`
	NodeID    string          `json:"nodeId"`
	Type      string          `json:"type"`
	IssuedAt  int64           `json:"issuedAt"`
	ExpiresAt int64           `json:"expiresAt"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type HelloFrame struct {
	T               string           `json:"t"`
	AgentVersion    string           `json:"agentVersion"`
	ProtocolVersion int              `json:"protocolVersion"`
	TS              int64            `json:"ts"`
	Facts           NodeFacts        `json:"facts"`
	Capabilities    []string         `json:"capabilities"`
	Workloads       []WorkloadStatus `json:"workloads"`
}

type HeartbeatFrame struct {
	T        string `json:"t"`
	TS       int64  `json:"ts"`
	UptimeMs int64  `json:"uptimeMs"`
}

type ProgressFrame struct {
	T       string   `json:"t"`
	ID      string   `json:"id"`
	TS      int64    `json:"ts"`
	Stage   string   `json:"stage"`
	Message string   `json:"message,omitempty"`
	Percent *float64 `json:"percent,omitempty"`
}

type AgentError struct {
	Code      ErrorCode       `json:"code"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Details   json.RawMessage `json:"details,omitempty"`
}

// ResultFrame covers both ok and error results (they share the `result` discriminator).
type ResultFrame struct {
	T     string          `json:"t"`
	ID    string          `json:"id"`
	TS    int64           `json:"ts"`
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *AgentError     `json:"error,omitempty"`
}

type MetricsFrame struct {
	T         string                 `json:"t"`
	TS        int64                  `json:"ts"`
	Node      NodeMetricSample       `json:"node"`
	Workloads []WorkloadMetricSample `json:"workloads"`
}

type EventFrame struct {
	T     string          `json:"t"`
	TS    int64           `json:"ts"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type LogsFrame struct {
	T          string    `json:"t"`
	WorkloadID string    `json:"workloadId"`
	Lines      []LogLine `json:"lines"`
	Dropped    *int64    `json:"dropped,omitempty"`
}

// WorkloadOOMEvent is the payload of `workload.oom` events.
type WorkloadOOMEvent struct {
	WorkloadID string `json:"workloadId"`
}

// AgentWarningEvent is the payload of `agent.warning` events.
type AgentWarningEvent struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
