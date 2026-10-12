// Package auth implements the agent identity: Ed25519 key files, BFAgent bearer tokens
// (agent-protocol.md §3) and staged credential-rotation proofs (§3.1).
package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/protocol"
)

// GenerateKey creates a new Ed25519 private key.
func GenerateKey() (ed25519.PrivateKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	return priv, err
}

// KeyFromSeedHex builds a key from a 32-byte hex seed (fixtures / tests only).
func KeyFromSeedHex(seedHex string) (ed25519.PrivateKey, error) {
	seed, err := hex.DecodeString(seedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("invalid seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// SaveKey writes the key as a PKCS#8 PEM file with mode 0600, atomically.
func SaveKey(path string, key ed25519.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return fileutil.WriteFileAtomic(path, data, 0o600)
}

// LoadKey reads a PKCS#8 PEM Ed25519 key.
func LoadKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s: not a PEM private key", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: not an Ed25519 key", path)
	}
	return priv, nil
}

// PublicKeyB64 returns the raw 32-byte public key as base64url without padding.
func PublicKeyB64(key ed25519.PrivateKey) string {
	return protocol.B64.EncodeToString(key.Public().(ed25519.PublicKey))
}

// ParsePublicKeyB64 decodes a base64url raw Ed25519 public key.
func ParsePublicKeyB64(s string) (ed25519.PublicKey, error) {
	b, err := protocol.B64.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("invalid Ed25519 public key (expected 32 bytes base64url)")
	}
	return ed25519.PublicKey(b), nil
}

// DefaultTokenTTL is the lifetime of a freshly minted BFAgent token (≤ 120 s per protocol).
const DefaultTokenTTL = 60 * time.Second

// NewToken mints `BFAgent <b64url(claims)>.<b64url(sig)>` with a fresh random jti.
func NewToken(key ed25519.PrivateKey, nodeID string, now time.Time, ttl time.Duration) (string, protocol.AgentTokenClaims, error) {
	var jti [18]byte
	if _, err := rand.Read(jti[:]); err != nil {
		return "", protocol.AgentTokenClaims{}, err
	}
	claims := protocol.AgentTokenClaims{
		Nid: nodeID,
		Aud: protocol.TokenAudience,
		Iat: now.UnixMilli(),
		Exp: now.Add(ttl).UnixMilli(),
		Jti: protocol.B64.EncodeToString(jti[:]),
	}
	h, err := SignClaims(key, claims)
	return h, claims, err
}

// SignClaims produces the Authorization header value for the given claims.
func SignClaims(key ed25519.PrivateKey, claims protocol.AgentTokenClaims) (string, error) {
	raw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	seg := protocol.B64.EncodeToString(raw)
	sig := ed25519.Sign(key, []byte(seg))
	return protocol.AuthScheme + " " + seg + "." + protocol.B64.EncodeToString(sig), nil
}

// VerifyToken applies the control-plane verification rules from §3 (except the durable jti store,
// which belongs to the control plane). Used by tests and the fake control plane.
func VerifyToken(header string, pub ed25519.PublicKey, now time.Time) (protocol.AgentTokenClaims, error) {
	var claims protocol.AgentTokenClaims
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || scheme != protocol.AuthScheme {
		return claims, errors.New("wrong auth scheme")
	}
	seg, sigB64, ok := strings.Cut(token, ".")
	if !ok {
		return claims, errors.New("malformed token")
	}
	sig, err := protocol.B64.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return claims, errors.New("malformed signature")
	}
	if !ed25519.Verify(pub, []byte(seg), sig) {
		return claims, errors.New("bad signature")
	}
	raw, err := protocol.B64.DecodeString(seg)
	if err != nil {
		return claims, errors.New("malformed claims")
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return claims, errors.New("malformed claims")
	}
	if !protocol.IsUUID(claims.Nid) {
		return claims, errors.New("invalid nid")
	}
	if claims.Aud != protocol.TokenAudience {
		return claims, errors.New("wrong audience")
	}
	if len(claims.Jti) < 16 || len(claims.Jti) > 128 {
		return claims, errors.New("invalid jti")
	}
	if claims.Exp-claims.Iat > protocol.TokenMaxLifetimeMs || claims.Exp < claims.Iat {
		return claims, errors.New("token lifetime too long")
	}
	n := now.UnixMilli()
	if n < claims.Iat-protocol.TokenClockSkewMs || n > claims.Exp {
		return claims, errors.New("token not valid now")
	}
	return claims, nil
}

func rotationMessage(nodeID, commandID string) []byte {
	return []byte(protocol.RotationProofPrefix + nodeID + ":" + commandID)
}

// RotationProof signs `blockforge-rotate:<nodeId>:<commandId>` with the NEXT key.
func RotationProof(next ed25519.PrivateKey, nodeID, commandID string) string {
	return protocol.B64.EncodeToString(ed25519.Sign(next, rotationMessage(nodeID, commandID)))
}

// VerifyRotationProof checks a proof against a public key.
func VerifyRotationProof(pub ed25519.PublicKey, nodeID, commandID, proof string) bool {
	sig, err := protocol.B64.DecodeString(proof)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, rotationMessage(nodeID, commandID), sig)
}
