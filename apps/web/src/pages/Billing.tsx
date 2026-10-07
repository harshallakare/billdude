/**
 * apps/web/src/pages/Billing.tsx
 *
 * Usage: billing page at /billing — wallet balance and runway, top-ups,
 * recent wallet transactions and links to monthly statements.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";
import { CheckoutCancelled, payTopup } from "../lib/checkout";

const PRESETS = [500, 1000, 2500, 5000];

export function BillingPage() {
  const queryClient = useQueryClient();
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: api.wallet });
  const txs = useQuery({ queryKey: ["transactions"], queryFn: api.transactions });
  const statements = useQuery({ queryKey: ["statements"], queryFn: api.statements });
  const [amount, setAmount] = useState(1000);
  const [notice, setNotice] = useState<string | null>(null);

  const topup = useMutation({
    mutationFn: async () => payTopup(await api.createTopup(amount)),
    onSuccess: (result) => {
      setNotice(result.status === "paid" ? `Payment received. New balance: ${result.currency} ${result.balance}` : "Payment is being processed.");
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    topup.mutate();
  };

  const w = wallet.data;
  const negative = w ? w.balance.startsWith("-") : false;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <ErrorText error={wallet.error} />

      {w?.overdueSince && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
          Your balance has been negative since {new Date(w.overdueSince).toLocaleString()}. Running servers are stopped{" "}
          {w.graceHours} hours after that unless you add funds. Stopped servers keep their data.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <p className="text-sm text-slate-500">Balance</p>
          <p className={`mt-1 text-3xl font-semibold ${negative ? "text-red-600" : ""}`}>
            {w ? `${w.currency} ${w.balance}` : "…"}
          </p>
          {w && (
            <p className="mt-2 text-sm text-slate-500">
              Spending {w.currency} {w.hourlyBurn}/hour
              {w.runwayHours !== null && <> · lasts about {formatRunway(w.runwayHours)}</>}
            </p>
          )}
        </Card>

        <Card className="md:col-span-2">
          <form onSubmit={submit} className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button key={p} type="button" variant={amount === p ? "primary" : "secondary"} onClick={() => setAmount(p)}>
                  {w?.currency ?? ""} {p.toLocaleString()}
                </Button>
              ))}
            </div>
            <Field label="Amount" hint={w ? `Between ${w.minTopup} and ${w.maxTopup.toLocaleString()} ${w.currency}` : undefined}>
              <Input
                type="number"
                min={w?.minTopup}
                max={w?.maxTopup}
                required
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </Field>
            {topup.error && !(topup.error instanceof CheckoutCancelled) && <ErrorText error={topup.error} />}
            {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {w?.gateway === "fake" ? "Development mode: payments are simulated." : "Secure payment via Razorpay (UPI, cards, netbanking)."}
              </span>
              <Button type="submit" disabled={topup.isPending}>
                {topup.isPending ? "Processing…" : "Add funds"}
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-x-auto p-0 lg:col-span-2">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Recent transactions</h2>
          <table className="mt-3 min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-2">Date</th>
                <th className="px-6 py-2">Description</th>
                <th className="px-6 py-2 text-right">Amount</th>
                <th className="px-6 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {txs.data?.transactions.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-6 text-center text-slate-500">
                    No transactions yet.
                  </td>
                </tr>
              )}
              {txs.data?.transactions.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap px-6 py-2 text-slate-500">{new Date(t.createdAt).toLocaleString()}</td>
                  <td className="px-6 py-2">{t.description}</td>
                  <td className={`whitespace-nowrap px-6 py-2 text-right font-mono ${t.amount.startsWith("-") ? "" : "text-emerald-700"}`}>
                    {t.amount.startsWith("-") ? t.amount : `+${t.amount}`}
                  </td>
                  <td className="whitespace-nowrap px-6 py-2 text-right font-mono">{t.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card className="p-0">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Monthly statements</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {statements.data?.statements.length === 0 && <li className="px-6 py-4 text-slate-500">No usage yet.</li>}
            {statements.data?.statements.map((s) => (
              <li key={s.month}>
                <Link to={`/billing/statements/${s.month}`} className="flex justify-between px-6 py-3 hover:bg-slate-50">
                  <span className="text-indigo-600">{formatMonth(s.month)}</span>
                  <span className="font-mono">
                    {statements.data.currency} {s.usage}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function formatRunway(hours: number): string {
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}
