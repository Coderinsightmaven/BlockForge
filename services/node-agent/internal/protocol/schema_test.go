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
		`"memoryLimitBytes":536870912,"cpuLimitMillicores":null,"networks":[],"stopCommand":"stop","restartPolicy":{"mode":"never"}}`
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
	_, known, _ := ParsePayload("backup.create", []byte(`{}`))
	if known {
		t.Fatal("backup.create must be unsupported in this agent")
	}
}
