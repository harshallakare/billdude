/**
 * apps/web/src/components/TicketBadge.tsx
 *
 * Usage: coloured status pill for support tickets.
 *   <TicketBadge status="open" />
 * Customers read "open" as "Awaiting support" and "answered" as "Awaiting your reply".
 */
import type { TicketStatus } from "../lib/api";

const STYLES: Record<TicketStatus, string> = {
  open: "bg-amber-100 text-amber-800",
  answered: "bg-indigo-100 text-indigo-800",
  closed: "bg-slate-100 text-slate-600",
};

export function TicketBadge({ status, staffView = false }: { status: TicketStatus; staffView?: boolean }) {
  const label =
    status === "open" ? (staffView ? "Needs reply" : "Awaiting support") : status === "answered" ? (staffView ? "Answered" : "Awaiting your reply") : "Closed";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[status]}`}>{label}</span>;
}
