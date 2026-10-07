/**
 * apps/api/src/firewall.ts
 *
 * Usage: validation and defaults for customer firewall rules.
 *
 *   firewallRuleInput.parse(body)        // zod schema for POST /api/firewall
 *   DEFAULT_FIREWALL_RULES               // seeded for every new customer (SSH + ping)
 *   toConnectorRules(rows)               // DB rows -> rules for VhiProject.syncFirewall()
 */
import type { FirewallRule } from "@billdude/vhi-connector";
import { isIP } from "node:net";
import { z } from "zod";
import type { FirewallRuleRow } from "./db/schema.js";

export const MAX_FIREWALL_RULES = 50;

export const DEFAULT_FIREWALL_RULES: (FirewallRule & { description: string })[] = [
  { protocol: "tcp", portMin: 22, portMax: 22, cidr: "0.0.0.0/0", description: "SSH" },
  { protocol: "icmp", portMin: null, portMax: null, cidr: "0.0.0.0/0", description: "Ping" },
];

/** true for "a.b.c.d/n" (n 0-32) and "ipv6/n" (n 0-128). */
export function isCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (!address || prefix === undefined || rest.length > 0 || !/^\d{1,3}$/.test(prefix)) return false;
  const version = isIP(address);
  const bits = Number(prefix);
  return (version === 4 && bits <= 32) || (version === 6 && bits <= 128);
}

const port = z.number().int().min(1).max(65535);

export const firewallRuleInput = z
  .object({
    protocol: z.enum(["tcp", "udp", "icmp", "any"]),
    portMin: port.nullish(),
    portMax: port.nullish(),
    cidr: z.string().trim().toLowerCase().refine(isCidr, "Use a network in CIDR form, e.g. 0.0.0.0/0 or 203.0.113.4/32"),
    description: z.string().trim().max(100).default(""),
  })
  .transform((r) => {
    const ported = r.protocol === "tcp" || r.protocol === "udp";
    return {
      ...r,
      portMin: ported ? (r.portMin ?? null) : null,
      portMax: ported ? (r.portMax ?? r.portMin ?? null) : null,
    };
  })
  .refine((r) => r.protocol === "icmp" || r.protocol === "any" || r.portMin !== null, {
    message: "TCP and UDP rules need a port",
    path: ["portMin"],
  })
  .refine((r) => r.portMin === null || r.portMax === null || r.portMax >= r.portMin, {
    message: "The end port must not be lower than the start port",
    path: ["portMax"],
  });

export function toConnectorRules(rows: Pick<FirewallRuleRow, "protocol" | "portMin" | "portMax" | "cidr">[]): FirewallRule[] {
  return rows.map((r) => ({ protocol: r.protocol, portMin: r.portMin, portMax: r.portMax, cidr: r.cidr }));
}
