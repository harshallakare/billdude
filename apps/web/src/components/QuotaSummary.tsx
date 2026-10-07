/**
 * apps/web/src/components/QuotaSummary.tsx
 *
 * Usage: compact usage-vs-limit meters for the signed-in customer's quotas.
 *   <QuotaSummary />     // fetches GET /api/account/quotas itself
 * Shown on the servers page; refreshes whenever the "servers" queries do.
 */
import { useQuery } from "@tanstack/react-query";
import { api, type Quotas } from "../lib/api";
import { Card } from "./ui";

const ITEMS: { key: keyof Quotas; label: string; format?: (n: number) => string }[] = [
  { key: "instances", label: "Servers" },
  { key: "cores", label: "vCPUs" },
  { key: "ramMb", label: "RAM", format: (n) => `${Math.round(n / 1024)} GB` },
  { key: "gigabytes", label: "Disk", format: (n) => `${n} GB` },
];

export function QuotaSummary({ refreshKey }: { refreshKey?: unknown }) {
  const { data } = useQuery({ queryKey: ["quotas", refreshKey], queryFn: api.quotas });
  if (!data) return null;

  return (
    <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
      {ITEMS.map(({ key, label, format = String }) => {
        const used = data.usage[key];
        const limit = data.limits[key];
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        return (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>{label}</span>
              <span>
                {format(used)} / {limit < 0 ? "∞" : format(limit)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100">
              <div
                className={`h-1.5 rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-indigo-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </Card>
  );
}
