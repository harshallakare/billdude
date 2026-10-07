/**
 * apps/web/src/pages/admin/Audit.tsx
 *
 * Usage: audit trail at /admin/audit — the latest 200 security- and
 * billing-relevant actions, filterable in the browser by text.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, ErrorText, Input } from "../../components/ui";
import { api } from "../../lib/api";

export function AdminAuditPage() {
  const { data, error } = useQuery({ queryKey: ["admin", "audit"], queryFn: api.admin.audit });
  const [filter, setFilter] = useState("");
  const rows = (data?.entries ?? []).filter(
    (e) => !filter || `${e.action} ${e.actorEmail} ${e.targetType} ${e.targetId ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <div className="w-72">
          <Input placeholder="Filter by action, email or id" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <ErrorText error={error} />
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap px-4 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-4 py-2">{e.actorEmail}</td>
                <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-500">
                  {e.targetType}
                  {e.targetId && `:${e.targetId.slice(0, 13)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
