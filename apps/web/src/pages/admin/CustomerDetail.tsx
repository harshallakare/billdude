/**
 * apps/web/src/pages/admin/CustomerDetail.tsx
 *
 * Usage: one customer at /admin/customers/:id — suspend/reactivate, edit
 * quotas (pushed to their VHI project), credit or debit the wallet, and see
 * their servers and recent wallet activity.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card, ErrorText, Field, Input, StatusBadge } from "../../components/ui";
import { api, type Quotas } from "../../lib/api";

const QUOTA_FIELDS: { key: keyof Quotas; label: string }[] = [
  { key: "instances", label: "Servers" },
  { key: "cores", label: "vCPUs" },
  { key: "ramMb", label: "RAM (MB)" },
  { key: "volumes", label: "Volumes" },
  { key: "gigabytes", label: "Disk (GB)" },
];

export function AdminCustomerDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["admin", "user", id], queryFn: () => api.admin.user(id) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin"] });

  const [quotas, setQuotas] = useState<Quotas | null>(null);
  useEffect(() => {
    if (detail.data) setQuotas(detail.data.user.effectiveQuotas);
  }, [detail.data]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const status = useMutation({
    mutationFn: (s: "active" | "suspended") => api.admin.setStatus(id, s),
    onSuccess: refresh,
  });
  const saveQuotas = useMutation({ mutationFn: (q: Quotas | null) => api.admin.setQuotas(id, q), onSuccess: refresh });
  const adjust = useMutation({
    mutationFn: () => api.admin.adjustWallet(id, amount, reason),
    onSuccess: () => {
      setAmount("");
      setReason("");
      refresh();
    },
  });

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (detail.error || !detail.data) return <ErrorText error={detail.error ?? "Customer not found"} />;
  const { user, servers, transactions } = detail.data;

  const submitQuotas = (e: FormEvent) => {
    e.preventDefault();
    saveQuotas.mutate(quotas);
  };
  const submitAdjust = (e: FormEvent) => {
    e.preventDefault();
    adjust.mutate();
  };

  return (
    <div className="space-y-6">
      <Link to="/admin/customers" className="text-sm text-indigo-600 hover:underline">
        ← Customers
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{user.name}</h1>
          <p className="text-sm text-slate-500">
            {user.email} · joined {new Date(user.createdAt).toLocaleDateString()}
            {user.vhiProjectId && <> · VHI project <span className="font-mono">{user.vhiProjectId}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono text-lg ${user.balance.startsWith("-") ? "text-red-600" : ""}`}>{user.balance}</span>
          {user.status === "active" ? (
            <Button
              variant="danger"
              disabled={status.isPending}
              onClick={() => window.confirm(`Suspend ${user.email}? They will be signed out immediately.`) && status.mutate("suspended")}
            >
              Suspend
            </Button>
          ) : (
            <Button disabled={status.isPending} onClick={() => status.mutate("active")}>
              Reactivate
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={status.error} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-sm font-semibold text-slate-700">
            Quotas {user.quotas ? <span className="text-indigo-600">(custom)</span> : <span className="text-slate-400">(defaults)</span>}
          </h2>
          {quotas && (
            <form onSubmit={submitQuotas} className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {QUOTA_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Input
                      type="number"
                      min={-1}
                      value={quotas[f.key]}
                      onChange={(e) => setQuotas({ ...quotas, [f.key]: Number(e.target.value) })}
                    />
                  </Field>
                ))}
              </div>
              <p className="text-xs text-slate-500">-1 means unlimited. Changes are pushed to the customer's VHI project.</p>
              <ErrorText error={saveQuotas.error} />
              <div className="flex justify-end gap-2">
                {user.quotas && (
                  <Button type="button" variant="secondary" disabled={saveQuotas.isPending} onClick={() => saveQuotas.mutate(null)}>
                    Reset to defaults
                  </Button>
                )}
                <Button type="submit" disabled={saveQuotas.isPending}>
                  Save quotas
                </Button>
              </div>
            </form>
          )}
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Adjust wallet</h2>
          <form onSubmit={submitAdjust} className="space-y-4">
            <Field label="Amount" hint="Positive to credit, negative to debit (e.g. -50)">
              <Input required pattern="-?\d+(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Reason (visible to the customer)">
              <Input required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <ErrorText error={adjust.error} />
            <div className="flex justify-end">
              <Button type="submit" disabled={adjust.isPending}>
                Apply
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Servers</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {servers.length === 0 && <li className="px-6 py-4 text-slate-500">No servers.</li>}
            {servers.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-6 py-3">
                <Link to={`/servers/${s.id}`} className="font-medium text-indigo-600 hover:underline">
                  {s.name}
                </Link>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-xs text-slate-500">{s.ipv4 ?? "—"}</span>
                  <StatusBadge status={s.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-0">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Recent wallet activity</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {transactions.length === 0 && <li className="px-6 py-4 text-slate-500">No transactions.</li>}
            {transactions.map((t) => (
              <li key={t.id} className="flex justify-between gap-4 px-6 py-3">
                <span className="min-w-0 truncate">{t.description}</span>
                <span className="whitespace-nowrap font-mono">{t.amount}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
