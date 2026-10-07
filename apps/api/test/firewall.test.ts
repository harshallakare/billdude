/**
 * apps/api/test/firewall.test.ts
 *
 * Usage: integration tests for customer firewall rules and their sync to the
 * VHI project's default security group. Run with `pnpm --filter @billdude/api test`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { isCidr } from "../src/firewall.js";
import { eventually, startStack, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

async function inboundRulesOf(email: string): Promise<string[] | null> {
  const [user] = await stack.db.select().from(users).where(eq(users.email, email));
  if (!user?.vhiProjectId) return null;
  const { projects } = (await stack.mock.inject({ method: "GET", url: "/_mock/projects" })).json() as {
    projects: { id: string; inboundRules: string[] }[];
  };
  return projects.find((p) => p.id === user.vhiProjectId)?.inboundRules.sort() ?? null;
}

describe("firewall", () => {
  it("validates CIDRs", () => {
    expect(isCidr("0.0.0.0/0")).toBe(true);
    expect(isCidr("203.0.113.4/32")).toBe(true);
    expect(isCidr("2001:db8::/32")).toBe(true);
    expect(isCidr("10.0.0.1")).toBe(false);
    expect(isCidr("10.0.0.0/33")).toBe(false);
    expect(isCidr("example.com/24")).toBe(false);
  });

  it("opens SSH and ping for new customers' VHI projects", async () => {
    const alice = await stack.signUp("alice@example.com");
    expect((await alice.get("/api/firewall")).body.rules.map((r: { description: string }) => r.description)).toEqual(["SSH", "Ping"]);
    const rules = await eventually(() => inboundRulesOf("alice@example.com"), (r) => r !== null && r.length === 2);
    expect(rules).toEqual(["icmp:-:0.0.0.0/0", "tcp:22-22:0.0.0.0/0"]);
  });

  it("adds and removes rules and pushes them to VHI", async () => {
    const bob = await stack.signUp("bob@example.com");
    await eventually(() => inboundRulesOf("bob@example.com"), (r) => r?.length === 2);

    const web = await bob.post("/api/firewall", { protocol: "tcp", portMin: 80, portMax: 443, cidr: "0.0.0.0/0", description: "Web" });
    expect(web.status).toBe(201);
    await eventually(() => inboundRulesOf("bob@example.com"), (r) => r?.includes("tcp:80-443:0.0.0.0/0") ?? false);

    const ssh = (await bob.get("/api/firewall")).body.rules.find((r: { description: string }) => r.description === "SSH");
    expect((await bob.delete(`/api/firewall/${ssh.id}`)).status).toBe(200);
    const rules = await eventually(
      () => inboundRulesOf("bob@example.com"),
      (r) => !(r?.includes("tcp:22-22:0.0.0.0/0") ?? true),
    );
    expect(rules).toEqual(["icmp:-:0.0.0.0/0", "tcp:80-443:0.0.0.0/0"]);
  });

  it("rejects invalid, duplicate and foreign rules", async () => {
    const carol = await stack.signUp("carol@example.com");
    const dave = await stack.signUp("dave@example.com");
    expect((await carol.post("/api/firewall", { protocol: "tcp", cidr: "0.0.0.0/0" })).status).toBe(400);
    expect((await carol.post("/api/firewall", { protocol: "tcp", portMin: 22, cidr: "nope" })).status).toBe(400);
    expect((await carol.post("/api/firewall", { protocol: "tcp", portMin: 900, portMax: 80, cidr: "0.0.0.0/0" })).status).toBe(400);
    expect((await carol.post("/api/firewall", { protocol: "tcp", portMin: 22, cidr: "0.0.0.0/0" })).status).toBe(409);
    const carolRule = (await carol.get("/api/firewall")).body.rules[0];
    expect((await dave.delete(`/api/firewall/${carolRule.id}`)).status).toBe(404);
  });
});
