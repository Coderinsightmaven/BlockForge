package protocol

import (
	"strings"
	"testing"
)

const wid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

func TestPayloadValidationStrictness(t *testing.T) {
	cases := []struct {
		name, typ, payload string
		ok                 bool
	}{
		{"valid delete", CmdFsDelete, `{"workloadId":"` + wid + `","path":"world","recursive":true}`, true},
		{"missing required bool", CmdFsDelete, `{"workloadId":"` + wid + `","path":"world"}`, false},
		{"null required bool", CmdFsDelete, `{"workloadId":"` + wid + `","path":"world","recursive":null}`, false},
		{"case-mismatched key is not the field", CmdFsDelete, `{"WORKLOADID":"` + wid + `","path":"x","recursive":true}`, false},
		{"unknown keys stripped", CmdWorkloadStart, `{"workloadId":"` + wid + `","extra":1}`, true},
		{"uuid wrong variant", CmdWorkloadStart, `{"workloadId":"1a2b3c4d-5e6f-4a7b-1c9d-0e1f2a3b4c5d"}`, false},
		{"root delete ./", CmdFsDelete, `{"workloadId":"` + wid + `","path":"./","recursive":true}`, false},
		{"root delete .\\", CmdFsDelete, `{"workloadId":"` + wid + `","path":".\\","recursive":false}`, false},
		{"root delete empty", CmdFsDelete, `{"workloadId":"` + wid + `","path":"","recursive":false}`, false},
		{"list root ok", CmdFsList, `{"workloadId":"` + wid + `","path":""}`, true},
		{"absolute path", CmdFsList, `{"workloadId":"` + wid + `","path":"/etc"}`, false},
		{"drive letter", CmdFsList, `{"workloadId":"` + wid + `","path":"C:\\x"}`, false},
		{"dotdot", CmdFsList, `{"workloadId":"` + wid + `","path":"a/../../b"}`, false},
		{"NUL", CmdFsList, `{"workloadId":"` + wid + `","path":"a\u0000b"}`, false},
		{"float for int", CmdFsRead, `{"workloadId":"` + wid + `","path":"a","maxBytes":1.5}`, false},
		{"exponent int ok", CmdFsRead, `{"workloadId":"` + wid + `","path":"a","maxBytes":1e3}`, true},
		{"maxBytes over 5MiB", CmdFsRead, `{"workloadId":"` + wid + `","path":"a","maxBytes":5242881}`, false},
		{"console newline", CmdWorkloadConsole, `{"workloadId":"` + wid + `","line":"say hi\nop me"}`, false},
		{"console ok", CmdWorkloadConsole, `{"workloadId":"` + wid + `","line":"say hi"}`, true},
		{"console 1024 utf16 units ok", CmdWorkloadConsole, `{"workloadId":"` + wid + `","line":"` + strings.Repeat("é", 1024) + `"}`, true},
		{"console 1025 utf16 units", CmdWorkloadConsole, `{"workloadId":"` + wid + `","line":"` + strings.Repeat("😀", 513) + `"}`, false},
		{"http url refused", CmdArtifactFetch, `{"workloadId":"` + wid + `","url":"http://x.y/z","destPath":"a","checksum":null,"maxBytes":1}`, false},
		{"https url ok", CmdArtifactFetch, `{"workloadId":"` + wid + `","url":"https://x.y/z","destPath":"a","checksum":null,"maxBytes":1}`, true},
		{"checksum missing (required nullable)", CmdArtifactFetch, `{"workloadId":"` + wid + `","url":"https://x.y/z","destPath":"a","maxBytes":1}`, false},
		{"bad image ref", CmdWorkloadEnsure, ensure(`"image":"Eclipse-Temurin:21"`), false},
		{"ensure ok", CmdWorkloadEnsure, ensure(`"image":"eclipse-temurin:21-jre"`), true},
		{"cpu missing (required nullable)", CmdWorkloadEnsure, strings.Replace(ensure(`"image":"eclipse-temurin:21-jre"`), `"cpuLimitMillicores":null,`, "", 1), false},
		{"host network name refused", CmdWorkloadEnsure, strings.Replace(ensure(`"image":"eclipse-temurin:21-jre"`), `"networks":[]`, `"networks":[{"name":"host"}]`, 1), false},
		{"payload not an object", CmdNodeFacts, `[]`, false},
		{"payload missing", CmdNodeFacts, ``, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, known, err := ParsePayload(c.typ, []byte(c.payload))
			if !known {
				t.Fatal("type unknown")
			}
			if (err == nil) != c.ok {
				t.Fatalf("ok=%v err=%v", c.ok, err)
			}
			if err != nil && err.Code != CodeValidationFailed {
				t.Fatalf("code %s", err.Code)
			}
		})
	}
}

func ensure(image string) string {
	return `{"workloadId":"` + wid + `","kind":"minecraft",` + image + `,"command":["java","-jar","server.jar"],` +
		`"memoryLimitBytes":536870912,"cpuLimitMillicores":null,"networks":[],"stop":{"type":"command","command":"stop"},"restartPolicy":{"mode":"never"}}`
}

func TestDefaults(t *testing.T) {
	p, _, err := ParsePayload(CmdWorkloadEnsure, []byte(ensure(`"image":"eclipse-temurin:21-jre"`)))
	if err != nil {
		t.Fatal(err)
	}
	s := p.(*WorkloadSpec)
	if s.PidsLimit != 4096 || s.StopTimeoutMs != 60000 || !s.JvmProbe || s.RestartPolicy.BackoffMs != 10000 ||
		s.Env == nil || s.Labels == nil || s.Ports == nil || s.CPULimitMillicores != nil {
		t.Fatalf("defaults not applied: %+v", s)
	}
	p, _, err = ParsePayload(CmdNodeProbe, []byte(`{"host":"h","port":25565,"kind":"tcp"}`))
	if err != nil || p.(*NodeProbePayload).TimeoutMs != 3000 {
		t.Fatalf("probe default: %v %+v", err, p)
	}
	_, known, _ := ParsePayload("workload.migrate", []byte(`{}`))
	if known {
		t.Fatal("workload.migrate must be unsupported in this agent")
	}
}

func TestPhase3Schemas(t *testing.T) {
	base := func(extra string) string {
		return `{"workloadId":"` + wid + `","kind":"generic","image":"ghcr.io/pterodactyl/yolks:java_21",` + extra +
			`"memoryLimitBytes":536870912,"cpuLimitMillicores":null,"stop":null,"restartPolicy":{"mode":"never"}}`
	}
	cases := []struct {
		name, typ, payload string
		ok                 bool
	}{
		{"image entrypoint, empty command", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],`), true},
		{"argv with empty command", CmdWorkloadEnsure, base(`"entrypoint":"argv","command":[],`), false},
		{"default entrypoint argv, empty command", CmdWorkloadEnsure, base(`"command":[],`), false},
		{"lowercase env key", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],"env":{"server_jar":"x","_A":"1"},`), true},
		{"env key starting with digit", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],"env":{"1X":"x"},`), false},
		{"env value 16 KiB", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],"env":{"STARTUP":"` + strings.Repeat("a", 16*1024) + `"},`), true},
		{"env value 16 KiB + 1", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],"env":{"STARTUP":"` + strings.Repeat("a", 16*1024+1) + `"},`), false},
		{"bad dataMountPath", CmdWorkloadEnsure, base(`"entrypoint":"image","command":[],"dataMountPath":"/srv",`), false},
		{"signal stop", CmdWorkloadEnsure, strings.Replace(base(`"entrypoint":"image","command":[],`), `"stop":null`, `"stop":{"type":"signal","signal":"SIGQUIT"}`, 1), true},
		{"bad signal", CmdWorkloadEnsure, strings.Replace(base(`"entrypoint":"image","command":[],`), `"stop":null`, `"stop":{"type":"signal","signal":"SIGHUP"}`, 1), false},
		{"command stop with newline", CmdWorkloadEnsure, strings.Replace(base(`"entrypoint":"image","command":[],`), `"stop":null`, `"stop":{"type":"command","command":"stop\nop me"}`, 1), false},
		{"unknown stop type", CmdWorkloadEnsure, strings.Replace(base(`"entrypoint":"image","command":[],`), `"stop":null`, `"stop":{"type":"exec","command":"x"}`, 1), false},
		{"stop missing", CmdWorkloadEnsure, strings.Replace(base(`"entrypoint":"image","command":[],`), `"stop":null,`, ``, 1), false},
		{"install ok", CmdWorkloadInstall, `{"workloadId":"` + wid + `","image":"ghcr.io/pterodactyl/installers:alpine","entrypoint":"ash","script":"echo","memoryLimitBytes":134217728,"cpuLimitMillicores":null}`, true},
		{"install bad entrypoint", CmdWorkloadInstall, `{"workloadId":"` + wid + `","image":"x","entrypoint":"python","script":"echo","memoryLimitBytes":134217728,"cpuLimitMillicores":null}`, false},
		{"install timeout too short", CmdWorkloadInstall, `{"workloadId":"` + wid + `","image":"x","entrypoint":"sh","script":"","memoryLimitBytes":134217728,"cpuLimitMillicores":null,"timeoutMs":1000}`, false},
		{"chmod ok", CmdFsChmod, `{"workloadId":"` + wid + `","path":"start.sh","mode":493}`, true},
		{"chmod setuid", CmdFsChmod, `{"workloadId":"` + wid + `","path":"start.sh","mode":2541}`, false},
		{"chmod root", CmdFsChmod, `{"workloadId":"` + wid + `","path":".","mode":493}`, false},
		{"compress ok", CmdFsCompress, `{"workloadId":"` + wid + `","root":"","paths":["world"],"format":"zip","maxTotalBytes":1000}`, true},
		{"compress root path", CmdFsCompress, `{"workloadId":"` + wid + `","root":"","paths":["."],"format":"zip","maxTotalBytes":1000}`, false},
		{"compress no paths", CmdFsCompress, `{"workloadId":"` + wid + `","root":"","paths":[],"format":"zip","maxTotalBytes":1000}`, false},
		{"find ok", CmdFsFind, `{"workloadId":"` + wid + `","path":"","query":"level"}`, true},
		{"find empty query", CmdFsFind, `{"workloadId":"` + wid + `","path":"","query":""}`, false},
		{"copy root", CmdFsCopy, `{"workloadId":"` + wid + `","path":""}`, false},
		{"node.ports", CmdNodePorts, `{}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, known, err := ParsePayload(c.typ, []byte(c.payload))
			if !known {
				t.Fatal("type unknown")
			}
			if (err == nil) != c.ok {
				t.Fatalf("ok=%v err=%v", c.ok, err)
			}
		})
	}
	p, _, _ := ParsePayload(CmdFsFind, []byte(`{"workloadId":"`+wid+`","path":"","query":"x"}`))
	if p.(*FsFindPayload).MaxResults != 100 {
		t.Fatal("find default")
	}
	p, _, _ = ParsePayload(CmdArtifactFetch, []byte(`{"workloadId":"`+wid+`","url":"https://x.y/z","destPath":"a","checksum":null,"maxBytes":1}`))
	if !p.(*ArtifactFetchPayload).Cache {
		t.Fatal("cache default must be true")
	}
	p, _, _ = ParsePayload(CmdWorkloadEnsure, []byte(ensure(`"image":"eclipse-temurin:21-jre"`)))
	if s := p.(*WorkloadSpec); s.Entrypoint != "argv" || s.DataMountPath != "/data" || !s.ReadOnlyRootfs {
		t.Fatalf("defaults %+v", s)
	}
}

func TestAgentErrorBounds(t *testing.T) {
	e := Errorf(CodeInternal, "%s", strings.Repeat("é", 5000)).WithDetails(map[string]any{"blob": strings.Repeat("x", 20000)})
	ae := e.ToAgentError()
	if UTF16Len(ae.Message) != MaxErrorMessage || !strings.HasPrefix(strings.Repeat("é", 5000), ae.Message) {
		t.Fatalf("message len %d", UTF16Len(ae.Message))
	}
	if string(ae.Details) != `{"truncated":true}` {
		t.Fatalf("details %s", ae.Details)
	}
	if got := TruncateUTF16(strings.Repeat("😀", 3), 5); got != "😀😀" {
		t.Fatalf("surrogate-safe truncation %q", got)
	}
	small := Errorf(CodeConflict, "x").WithDetails(map[string]any{"a": 1}).ToAgentError()
	if string(small.Details) != `{"a":1}` {
		t.Fatal(string(small.Details))
	}
}
