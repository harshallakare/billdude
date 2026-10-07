/**
 * apps/api/src/ssh.ts
 *
 * Usage: SSH public-key validation and cloud-init generation.
 *
 *   const key = parsePublicKey("ssh-ed25519 AAAA… me@laptop");   // throws on invalid input
 *   key.fingerprint  // "SHA256:…" (same format as `ssh-keygen -lf`)
 *   const userData = buildCloudInit(["ssh-ed25519 AAAA…"]);      // #cloud-config text for Nova
 */
import { createHash } from "node:crypto";

const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

export interface ParsedKey {
  type: string;
  /** Normalised "type base64 [comment]" line. */
  publicKey: string;
  fingerprint: string;
  comment: string;
}

export class InvalidSshKeyError extends Error {}

export function parsePublicKey(input: string): ParsedKey {
  const parts = input.trim().split(/\s+/);
  const [type, blob, ...rest] = parts;
  if (!type || !blob || !KEY_TYPES.has(type)) {
    throw new InvalidSshKeyError("Not a supported SSH public key (expected ssh-ed25519, ssh-rsa or ecdsa-sha2-*)");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new InvalidSshKeyError("SSH key data is not valid base64");

  const raw = Buffer.from(blob, "base64");
  // The blob starts with a length-prefixed copy of the key type; it must match.
  const typeLength = raw.length >= 4 ? raw.readUInt32BE(0) : -1;
  const embeddedType = typeLength > 0 && typeLength < 64 ? raw.subarray(4, 4 + typeLength).toString("ascii") : "";
  if (embeddedType !== type) throw new InvalidSshKeyError("SSH key data does not match its declared type");
  if (type === "ssh-rsa" && raw.length < 270) throw new InvalidSshKeyError("RSA keys must be at least 2048 bits");

  const comment = rest.join(" ").slice(0, 200);
  const fingerprint = `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
  return { type, publicKey: [type, blob, comment].filter(Boolean).join(" "), fingerprint, comment };
}

/** cloud-init config that installs the given keys for the image's default user and disables password SSH. */
export function buildCloudInit(publicKeys: string[]): string {
  const lines = ["#cloud-config", "ssh_pwauth: false"];
  if (publicKeys.length > 0) {
    lines.push("ssh_authorized_keys:");
    for (const key of publicKeys) lines.push(`  - ${JSON.stringify(key)}`);
  }
  return `${lines.join("\n")}\n`;
}
