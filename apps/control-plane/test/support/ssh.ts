import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** SSH `mpint`: big-endian, minimal, with a leading zero byte when the high bit is set. */
function mpint(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return sshString(v);
}

/** authorized_keys line for a Node public key (ed25519, ECDSA P-256/384/521, RSA), built independently of the code under test. */
export function authorizedKey(pub: KeyObject, comment = "test@example"): { line: string; blob: Buffer; fingerprint: string } {
  const jwk = pub.export({ format: "jwk" });
  let type: string;
  let blob: Buffer;
  if (jwk.kty === "OKP") {
    type = "ssh-ed25519";
    blob = Buffer.concat([sshString(type), sshString(Buffer.from(jwk.x!, "base64url"))]);
  } else if (jwk.kty === "EC") {
    const curve = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" }[jwk.crv as string]!;
    type = `ecdsa-sha2-${curve}`;
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    blob = Buffer.concat([sshString(type), sshString(curve), sshString(point)]);
  } else {
    type = "ssh-rsa";
    blob = Buffer.concat([sshString(type), mpint(Buffer.from(jwk.e!, "base64url")), mpint(Buffer.from(jwk.n!, "base64url"))]);
  }
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  return { line: `${type} ${blob.toString("base64")} ${comment}`, blob, fingerprint };
}

export function ed25519Key(comment?: string) {
  return authorizedKey(generateKeyPairSync("ed25519").publicKey, comment);
}
