/**
 * apps/web/src/pages/Servers.tsx
 *
 * Usage: server list at /servers. Polls every 3s while any server is in a
 * transitional state (building, stopping, …) so statuses update live.
 * Admins get a toggle to see every customer's servers.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, StatusBadge } from "../components/ui";
import { api, TRANSITIONAL } from "../lib/api";
import { useCurrentUser } from "../lib/auth";

export function ServersPage() {
  const { data: user } = useCurrentUser();
  const [showAll, setShowAll] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ["servers", showAll],
    queryFn: () => api.listServers(showAll),
    refetchInterval: (query) =>
      query.state.data?.servers.some((s) => TRANSITIONAL.includes(s.status)) ? 3_000 : false,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Servers</h1>
        <div className="flex items-center gap-3">
          {user?.role === "admin" && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              All customers
            </label>
          )}
          <Link to="/servers/new">
            <Button>Create server</Button>
          </Link>
        </div>
      </div>

      <ErrorText error={error} />

      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">IPv4</th>
              <th className="px-4 py-3">Disk</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {data?.servers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                  No servers yet.{" "}
                  <Link to="/servers/new" className="text-indigo-600 hover:underline">
                    Create your first one
                  </Link>
                  .
                </td>
              </tr>
            )}
            {data?.servers.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">
                  <Link to={`/servers/${s.id}`} className="text-indigo-600 hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={s.status} />
                </td>
                <td className="px-4 py-3 font-mono text-xs">{s.ipv4 ?? "—"}</td>
                <td className="px-4 py-3">{s.bootVolumeGb} GB</td>
                <td className="px-4 py-3 text-slate-500">{new Date(s.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
