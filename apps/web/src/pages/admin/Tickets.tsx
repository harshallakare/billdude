/**
 * apps/web/src/pages/admin/Tickets.tsx
 *
 * Usage: support queue at /admin/tickets, filterable by status. Rows open
 * the shared conversation view at /support/:id where admins reply as "Support".
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { TicketBadge } from "../../components/TicketBadge";
import { Button, Card, ErrorText } from "../../components/ui";
import { api, type TicketStatus } from "../../lib/api";

const FILTERS: { value: TicketStatus | undefined; label: string }[] = [
  { value: "open", label: "Needs reply" },
  { value: "answered", label: "Answered" },
  { value: "closed", label: "Closed" },
  { value: undefined, label: "All" },
];

export function AdminTicketsPage() {
  const [status, setStatus] = useState<TicketStatus | undefined>("open");
  const { data, error } = useQuery({
    queryKey: ["admin", "tickets", status],
    queryFn: () => api.admin.tickets(status),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tickets</h1>
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <Button key={f.label} variant={status === f.value ? "primary" : "secondary"} onClick={() => setStatus(f.value)}>
              {f.label}
            </Button>
          ))}
        </div>
      </div>
      <ErrorText error={error} />
      <Card className="p-0">
        <ul className="divide-y divide-slate-100">
          {data?.tickets.length === 0 && <li className="px-6 py-6 text-sm text-slate-500">Nothing here.</li>}
          {data?.tickets.map((t) => (
            <li key={t.id}>
              <Link to={`/support/${t.id}`} className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-slate-50">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">{t.subject}</p>
                  <p className="text-xs text-slate-500">
                    {t.customerName} ({t.customerEmail}) · updated {new Date(t.updatedAt).toLocaleString()}
                  </p>
                </div>
                <TicketBadge status={t.status} staffView />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
