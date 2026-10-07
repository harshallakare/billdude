/**
 * apps/web/src/pages/TicketThread.tsx
 *
 * Usage: one support conversation at /support/:id. Used by customers and by
 * admins (who reply as "Support"). Reply, or close the ticket.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { TicketBadge } from "../components/TicketBadge";
import { Button, Card, ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { useCurrentUser } from "../lib/auth";

export function TicketThreadPage() {
  const { id = "" } = useParams();
  const { data: me } = useCurrentUser();
  const queryClient = useQueryClient();
  const thread = useQuery({ queryKey: ["ticket", id], queryFn: () => api.ticket(id), refetchInterval: 30_000 });
  const [body, setBody] = useState("");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ticket", id] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "tickets"] });
  };
  const reply = useMutation({
    mutationFn: () => api.replyTicket(id, body),
    onSuccess: () => {
      setBody("");
      refresh();
    },
  });
  const close = useMutation({ mutationFn: () => api.closeTicket(id), onSuccess: refresh });

  if (thread.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (thread.error || !thread.data) return <ErrorText error={thread.error ?? "Ticket not found"} />;
  const { ticket, messages } = thread.data;
  const staffView = me?.role === "admin" && ticket.userId !== me.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    reply.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to={me?.role === "admin" ? "/admin/tickets" : "/support"} className="text-sm text-indigo-600 hover:underline">
        ← Back to tickets
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{ticket.subject}</h1>
        <div className="flex items-center gap-3">
          <TicketBadge status={ticket.status} staffView={staffView} />
          {ticket.status !== "closed" && (
            <Button variant="secondary" disabled={close.isPending} onClick={() => close.mutate()}>
              Close ticket
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {messages.map((m) => (
          <Card key={m.id} className={m.fromStaff ? "border-indigo-200 bg-indigo-50/40" : ""}>
            <div className="mb-2 flex justify-between text-xs text-slate-500">
              <span className="font-medium text-slate-700">{m.authorName}</span>
              <span>{new Date(m.createdAt).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-800">{m.body}</p>
          </Card>
        ))}
      </div>

      <Card>
        <form onSubmit={submit} className="space-y-3">
          <textarea
            required
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={ticket.status === "closed" ? "Replying will reopen this ticket" : "Write a reply"}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <ErrorText error={reply.error ?? close.error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={reply.isPending}>
              {reply.isPending ? "Sending…" : "Send reply"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
