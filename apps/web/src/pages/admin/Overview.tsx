/**
 * apps/web/src/pages/admin/Overview.tsx
 *
 * Usage: admin dashboard at /admin — customers, servers, money this month,
 * open tickets — plus a button to run billing immediately.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText } from "../../components/ui";
import { api } from "../../lib/api";

export function AdminOverviewPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["admin", "overview"], queryFn: api.admin.overview, refetchInterval: 60_000 });
  const run = useMutation({
    mutationFn: api.admin.runBilling,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <Button variant="secondary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Running…" : "Run billing now"}
        </Button>
      </div>
      <ErrorText error={error ?? run.error} />
      {run.data && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Charged {run.data.charged} server periods ({data?.currency} {run.data.total}); stopped {run.data.stopped} for non-payment.
        </p>
      )}
      {data && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Customers" value={data.customers} detail={`${data.overdue} overdue · ${data.suspended} suspended`} to="/admin/customers" />
          <Stat label="Servers" value={data.servers.active} detail={`active of ${data.servers.total} · ${data.servers.error} in error`} />
          <Stat
            label="Top-ups this month"
            value={`${data.currency} ${data.thisMonth.topups}`}
            detail={`Usage billed: ${data.currency} ${data.thisMonth.usage}`}
          />
          <Stat label="Open tickets" value={data.openTickets} detail={`Wallets hold ${data.currency} ${data.walletTotal}`} to="/admin/tickets" />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, detail, to }: { label: string; value: string | number; detail: string; to?: string }) {
  const body = (
    <Card className="h-full p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </Card>
  );
  return to ? (
    <Link to={to} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
