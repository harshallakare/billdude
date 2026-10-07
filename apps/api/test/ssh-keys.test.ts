/**
 * apps/api/test/ssh-keys.test.ts
 *
 * Usage: integration tests for SSH key management and cloud-init injection.
 * Run with `pnpm --filter @billdude/api test`.
 */
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servers } from "../src/db/schema.js";
import { buildCloudInit, parsePublicKey } from "../src/ssh.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

/** Builds an OpenSSH-format ed25519 public key line. */
function newEd25519Key(comment = "test@billdude"): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const lenPrefixed = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const blob = Buffer.concat([lenPrefixed(Buffer.from("ssh-ed25519")), lenPrefixed(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

describe("ssh key parsing", () => {
  it("accepts a valid key and computes an OpenSSH-style fingerprint", () => {
    const parsed = parsePublicKey(newEd25519Key("me@laptop"));
    expect(parsed.type).toBe("ssh-ed25519");
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(parsed.comment).toBe("me@laptop");
  });

  it("rejects garbage and mismatched types", () => {
    expect(() => parsePublicKey("hello world")).toThrow();
    const key = newEd25519Key();
    expect(() => parsePublicKey(key.replace("ssh-ed25519", "ssh-rsa"))).toThrow(/does not match/);
  });

  it("renders cloud-init with quoted keys", () => {
    expect(buildCloudInit(["ssh-ed25519 AAAA x"])).toBe(
      '#cloud-config\nssh_pwauth: false\nssh_authorized_keys:\n  - "ssh-ed25519 AAAA x"\n',
    );
  });
});

describe("ssh keys api", () => {
  it("adds, lists, de-duplicates and deletes keys", async () => {
    const alice = await stack.signUp("alice@example.com");
    const key = newEd25519Key();
    const created = await alice.post("/api/ssh-keys", { name: "laptop", publicKey: key });
    expect(created.status).toBe(201);
    expect((await alice.post("/api/ssh-keys", { name: "again", publicKey: key })).status).toBe(409);
    expect((await alice.post("/api/ssh-keys", { name: "bad", publicKey: "nope" })).status).toBe(400);

    const list = await alice.get("/api/ssh-keys");
    expect(list.body.sshKeys).toHaveLength(1);

    const bob = await stack.signUp("bob@example.com");
    expect((await bob.delete(`/api/ssh-keys/${created.body.sshKey.id}`)).status).toBe(404);
    expect((await alice.delete(`/api/ssh-keys/${created.body.sshKey.id}`)).status).toBe(200);
    expect((await alice.get("/api/ssh-keys")).body.sshKeys).toEqual([]);
  });

  it("injects selected keys into the VM via cloud-init", async () => {
    const carol = await stack.signUp("carol@example.com");
    const key = newEd25519Key("carol@desk");
    const { body } = await carol.post("/api/ssh-keys", { name: "desk", publicKey: key });

    const res = await carol.post("/api/servers", { ...VALID_SERVER, sshKeyIds: [body.sshKey.id] });
    expect(res.status).toBe(202);
    const id = res.body.server.id as string;
    await eventually(
      () => carol.get(`/api/servers/${id}`).then((r) => r.body.server.status),
      (s) => s === "active",
    );

    const [row] = await stack.db.select().from(servers).where(eq(servers.id, id));
    const inspect = await stack.mock.inject({ method: "GET", url: `/_mock/servers/${row!.vhiServerId}` });
    expect(inspect.json().userData).toContain(key);
    expect(inspect.json().userData).toMatch(/^#cloud-config/);
  });

  it("refuses keys that belong to someone else", async () => {
    const dave = await stack.signUp("dave@example.com");
    const erin = await stack.signUp("erin@example.com");
    const { body } = await dave.post("/api/ssh-keys", { name: "k", publicKey: newEd25519Key() });
    const res = await erin.post("/api/servers", { ...VALID_SERVER, sshKeyIds: [body.sshKey.id] });
    expect(res.status).toBe(400);
  });
});
