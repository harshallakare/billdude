/**
 * apps/web/src/pages/Firewall.tsx
 *
 * Usage: inbound firewall at /firewall. Rules apply to all of the customer's
 * servers; outbound traffic is always allowed. Quick-add buttons cover the
 * common services.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "../components/ui";
import { api, type FirewallRule } from "../lib/api";

type Draft = { protocol: FirewallRule["protocol"]; portMin: string; portMax: string; cidr: string; description: string };

const EMPTY: Draft = { protocol: "tcp", portMin: "", portMax: "", cidr: "0.0.0.0/0", description: "" };

const PRESETS: { label: string; draft: Draft }[] = [
  { label: "HTTP", draft: { ...EMPTY, portMin: "80", description: "HTTP" } },
  { label: "HTTPS", draft: { ...EMPTY, portMin: "443", description: "HTTPS" } },
  { label: "SSH", draft: { ...EMPTY, portMin: "22", description: "SSH" } },
  { label: "RDP", draft: { ...EMPTY, portMin: "3389", description: "RDP" } },
  { label: "Ping", draft: { ...EMPTY, protocol: "icmp", description: "Ping" } },
];

export function FirewallPage() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["firewall"], queryFn: api.firewall });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["firewall"] });

  const add = useMutation({
    mutationFn: (d: Draft) =>
      api.addFirewallRule({
        protocol: d.protocol,
        portMin: d.portMin ? Number(d.portMin) : null,
        portMax: d.portMax ? Number(d.portMax) : null,
        cidr: d.cidr,
        description: d.description,
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteFirewallRule, onSuccess: refresh });
  const ported = draft.protocol === "tcp" || draft.protocol === "udp";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(draft);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Firewall</h1>
        <p className="mt-1 text-sm text-slate-600">
          Inbound rules for all your servers. Anything not listed here is blocked; outbound traffic is always allowed.
        </p>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="self-center text-sm text-slate-500">Quick add:</span>
          {PRESETS.map((p) => (
            <Button key={p.label} variant="secondary" disabled={add.isPending} onClick={() => add.mutate(p.draft)}>
              {p.label}
            </Button>
          ))}
        </div>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-6">
          <Field label="Protocol">
            <Select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as Draft["protocol"] })}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="icmp">ICMP</option>
              <option value="any">Any</option>
            </Select>
          </Field>
          <Field label="Port">
            <Input disabled={!ported} required={ported} placeholder="22" value={draft.portMin} onChange={(e) => setDraft({ ...draft, portMin: e.target.value })} />
          </Field>
          <Field label="To port">
            <Input disabled={!ported} placeholder="optional" value={draft.portMax} onChange={(e) => setDraft({ ...draft, portMax: e.target.value })} />
          </Field>
          <Field label="Source (CIDR)">
            <Input required value={draft.cidr} onChange={(e) => setDraft({ ...draft, cidr: e.target.value })} />
          </Field>
          <Field label="Description">
            <Input maxLength={100} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" className="w-full" disabled={add.isPending}>
              Add rule
            </Button>
          </div>
        </form>
        <div className="mt-3">
          <ErrorText error={add.error ?? remove.error} />
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3">Protocol</th>
              <th className="px-4 py-3">Ports</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.data?.rules.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No inbound rules — your servers are unreachable from the internet.
                </td>
              </tr>
            )}
            {rules.data?.rules.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3">{r.description || "—"}</td>
                <td className="px-4 py-3 uppercase">{r.protocol}</td>
                <td className="px-4 py-3 font-mono">
                  {r.portMin === null ? "all" : r.portMin === r.portMax ? r.portMin : `${r.portMin}–${r.portMax}`}
                </td>
                <td className="px-4 py-3 font-mono">{r.cidr}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
