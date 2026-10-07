/**
 * apps/web/src/pages/Account.tsx
 *
 * Usage: account settings at /account — profile summary, email verification
 * status (with resend) and password change (signs out other sessions).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";
import { ME_KEY, useCurrentUser } from "../lib/auth";

export function AccountPage() {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
  const resend = useMutation({ mutationFn: api.resendVerification });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Account</h1>
      <Card>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Name</dt>
            <dd className="font-medium">{user?.name}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Email</dt>
            <dd className="font-medium">
              {user?.email}{" "}
              {user?.emailVerified ? (
                <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">verified</span>
              ) : (
                <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">not verified</span>
              )}
            </dd>
          </div>
        </dl>
        {!user?.emailVerified && (
          <div className="mt-4 flex items-center gap-3">
            <Button variant="secondary" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
              {resend.isSuccess ? "Email sent" : "Resend confirmation email"}
            </Button>
            <ErrorText error={resend.error} />
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-slate-700">Change password</h2>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 10 characters. Other devices will be signed out.">
            <Input type="password" autoComplete="new-password" minLength={10} required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <ErrorText error={change.error} />
          {change.isSuccess && <p className="text-sm text-emerald-700">Password changed.</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={change.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
