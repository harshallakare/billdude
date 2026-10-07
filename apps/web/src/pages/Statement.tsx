/**
 * apps/web/src/pages/Statement.tsx
 *
 * Usage: monthly usage statement at /billing/statements/:month (YYYY-MM):
 * per-server hours and charges, payments, opening and closing balance.
 * Printable with the browser's print dialog.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button, Card, ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { formatMonth } from "./Billing";

export function StatementPage() {
  const { month = "" } = useParams();
  const { data, error, isLoading } = useQuery({ queryKey: ["statement", month], queryFn: () => api.statement(month) });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error || !data) return <ErrorText error={error ?? "Statement not found"} />;
  const c = data.currency;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <Link to="/billing" className="text-sm text-indigo-600 hover:underline">
          ← Billing
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <h1 className="text-2xl font-semibold">Statement — {formatMonth(data.month)}</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Summary label="Opening balance" value={`${c} ${data.openingBalance}`} />
        <Summary label="Usage" value={`${c} ${data.usageTotal}`} />
        <Summary label="Closing balance" value={`${c} ${data.closingBalance}`} />
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-6 py-2">Server</th>
              <th className="px-6 py-2">Size</th>
              <th className="px-6 py-2 text-right">Hours</th>
              <th className="px-6 py-2 text-right">Compute</th>
              <th className="px-6 py-2 text-right">Storage</th>
              <th className="px-6 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.lines.map((l) => (
              <tr key={`${l.serverId}-${l.flavorId}`}>
                <td className="px-6 py-2 font-medium">{l.name}</td>
                <td className="px-6 py-2 text-slate-500">
                  {l.flavorId} · {l.diskGb} GB
                </td>
                <td className="px-6 py-2 text-right font-mono">{l.hours.toFixed(2)}</td>
                <td className="px-6 py-2 text-right font-mono">{l.compute}</td>
                <td className="px-6 py-2 text-right font-mono">{l.storage}</td>
                <td className="px-6 py-2 text-right font-mono">{l.total}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={5} className="px-6 py-3 text-right">
                Total usage
              </td>
              <td className="px-6 py-3 text-right font-mono">
                {c} {data.usageTotal}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {data.payments.length > 0 && (
        <Card className="p-0">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Payments and credits</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {data.payments.map((p, i) => (
              <li key={i} className="flex justify-between px-6 py-3">
                <span>
                  {new Date(p.createdAt).toLocaleDateString()} — {p.description}
                </span>
                <span className="font-mono">{p.amount}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </Card>
  );
}
