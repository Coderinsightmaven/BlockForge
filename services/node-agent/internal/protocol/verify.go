package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// Rejection reasons, named like the TypeScript reference verifier in agent-fixtures.test.ts.
const (
	RejectBadSignature = "bad-signature"
	RejectMalformed    = "malformed"
	RejectWrongNode    = "wrong-node"
	RejectExpired      = "expired"
	RejectLifetime     = "lifetime"
)

// B64 is base64url without padding (protocol §1).
var B64 = base64.RawURLEncoding

// VerifyCommand performs the envelope checks in protocol order: signature over the exact body
// bytes with the pinned control-plane key → body shape → nodeId → expiry (+grace) → lifetime.
// It returns the parsed body on success, or a rejection reason. Payload validation and the
// seen-set are the caller's responsibility (they come next in the protocol order).
func VerifyCommand(frame CommandFrame, cpKey ed25519.PublicKey, nodeID string, now time.Time) (*CommandBody, string) {
	sig, err := B64.DecodeString(frame.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize || len(cpKey) != ed25519.PublicKeySize {
		return nil, RejectBadSignature
	}
	if !ed25519.Verify(cpKey, []byte(frame.Body), sig) {
		return nil, RejectBadSignature
	}
	body, err := ParseCommandBody([]byte(frame.Body))
	if err != nil {
		return nil, RejectMalformed
	}
	if body.NodeID != nodeID {
		return body, RejectWrongNode
	}
	nowMs := now.UnixMilli()
	if nowMs > body.ExpiresAt+CommandExpiryGraceMs {
		return body, RejectExpired
	}
	if body.ExpiresAt-body.IssuedAt > CommandMaxLifetimeMs {
		return body, RejectLifetime
	}
	return body, ""
}

var commandBodySchema = Obj(
	F("id", uuidSchema),
	F("nodeId", uuidSchema),
	F("type", Str()),
	F("issuedAt", Int().Min(0)),
	F("expiresAt", Int().Min(0)),
)

// ParseCommandBody validates the CommandBody envelope (the type is checked against the catalogue later
// so unknown types can be answered with UNSUPPORTED_COMMAND).
func ParseCommandBody(raw []byte) (*CommandBody, error) {
	var probe CommandBody
	if perr := Validate(commandBodySchema, raw, &probe); perr != nil {
		return nil, fmt.Errorf("%s", perr.Message)
	}
	// Keep the raw payload bytes exactly as signed.
	var withPayload struct {
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &withPayload); err != nil {
		return nil, err
	}
	probe.Payload = withPayload.Payload
	return &probe, nil
}

// BestEffortID extracts a syntactically valid command id from an (untrusted) body so a rejection
// can still be correlated by the control plane. Returns "" if none.
func BestEffortID(body string) string {
	var b struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(body), &b) != nil || !IsUUID(b.ID) {
		return ""
	}
	return b.ID
}
