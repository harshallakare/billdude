/**
 * apps/web/src/pages/Support.tsx
 *
 * Usage: customer support at /support — list of own tickets and a form to open one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TicketBadge } from "../components/TicketBadge";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";

export function SupportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tickets = useQuery({ queryKey: ["tickets"], queryFn: api.tickets });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => api.createTicket(subject, body),
    onSuccess: ({ ticket }) => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      navigate(`/support/${ticket.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Support</h1>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Open a ticket</h2>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Subject">
              <Input required minLength={3} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="How can we help?" hint="Include server names and what you expected to happen.">
              <textarea
                required
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </Field>
            <ErrorText error={create.error} />
            <div className="flex justify-end">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        </Card>

        <Card className="p-0 lg:col-span-3">
          <h2 className="px-6 pt-5 text-sm font-semibold text-slate-700">Your tickets</h2>
          <ErrorText error={tickets.error} />
          <ul className="mt-3 divide-y divide-slate-100">
            {tickets.data?.tickets.length === 0 && <li className="px-6 py-6 text-sm text-slate-500">No tickets yet.</li>}
            {tickets.data?.tickets.map((t) => (
              <li key={t.id}>
                <Link to={`/support/${t.id}`} className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{t.subject}</p>
                    <p className="text-xs text-slate-500">Updated {new Date(t.updatedAt).toLocaleString()}</p>
                  </div>
                  <TicketBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
