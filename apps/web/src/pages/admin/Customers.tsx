/**
 * apps/web/src/pages/admin/Customers.tsx
 *
 * Usage: customer list at /admin/customers with search; rows link to the
 * customer detail page.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorText, Input } from "../../components/ui";
import { api } from "../../lib/api";

export function AdminCustomersPage() {
  const { data, error } = useQuery({ queryKey: ["admin", "users"], queryFn: api.admin.users });
  const [search, setSearch] = useState("");
  const rows = (data?.users ?? []).filter(
    (u) => !search || u.email.includes(search.toLowerCase()) || u.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <div className="w-64">
          <Input placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      <ErrorText error={error} />
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Balance</th>
              <th className="px-4 py-3">Server quota</th>
              <th className="px-4 py-3">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/admin/customers/${u.id}`} className="font-medium text-indigo-600 hover:underline">
                    {u.name}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {u.email}
                    {u.role === "admin" && " · admin"}
                  </p>
                </td>
                <td className="px-4 py-3">
                  {u.status === "suspended" ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">Suspended</span>
                  ) : u.overdueSince ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Overdue</span>
                  ) : (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Active</span>
                  )}
                </td>
                <td className={`px-4 py-3 text-right font-mono ${u.balance.startsWith("-") ? "text-red-600" : ""}`}>{u.balance}</td>
                <td className="px-4 py-3 text-slate-600">
                  {u.effectiveQuotas.instances < 0 ? "unlimited" : u.effectiveQuotas.instances}
                  {u.quotas && <span className="ml-1 text-xs text-indigo-600">(custom)</span>}
                </td>
                <td className="px-4 py-3 text-slate-500">{new Date(u.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
