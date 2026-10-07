/**
 * apps/web/src/pages/PasswordReset.tsx
 *
 * Usage: public pages for the emailed account links.
 *   /forgot-password            ask for a reset link
 *   /reset-password?token=…     choose a new password (signs out every session)
 *   /verify-email?token=…       confirm the email address
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";
import { ME_KEY } from "../lib/auth";
import { AuthShell } from "./Login";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => api.forgotPassword(email) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };

  return (
    <AuthShell title="Reset your password">
      {send.isSuccess ? (
        <p className="text-sm text-slate-700">
          If an account exists for <strong>{email}</strong>, we have emailed a link to reset the password. It is valid for one hour.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorText error={send.error} />
          <Button type="submit" className="w-full" disabled={send.isPending}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="text-indigo-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const reset = useMutation({
    mutationFn: () => {
      if (password !== confirm) throw new Error("The passwords do not match");
      return api.resetPassword(params.get("token") ?? "", password);
    },
    onSuccess: () => setTimeout(() => navigate("/login"), 1500),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate();
  };

  return (
    <AuthShell title="Choose a new password">
      {reset.isSuccess ? (
        <p className="text-sm text-slate-700">Your password was changed. Taking you to sign in…</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" hint="At least 10 characters">
            <Input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repeat new password">
            <Input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <ErrorText error={reset.error} />
          <Button type="submit" className="w-full" disabled={reset.isPending}>
            Set password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.verifyEmail(params.get("token") ?? ""),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
  const { mutate } = verify;
  useEffect(() => mutate(), [mutate]);

  return (
    <AuthShell title="Confirm your email">
      {verify.isPending && <p className="text-sm text-slate-600">Confirming…</p>}
      {verify.isSuccess && (
        <p className="text-sm text-slate-700">
          Thanks — your email address is confirmed.{" "}
          <Link to="/servers" className="font-medium text-indigo-600 hover:underline">
            Continue to your servers
          </Link>
        </p>
      )}
      <ErrorText error={verify.error} />
    </AuthShell>
  );
}
