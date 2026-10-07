/**
 * apps/web/src/pages/Login.tsx
 *
 * Usage: sign-in screen at /login. On success returns the user to the page
 * they originally asked for (or /servers).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";
import { ME_KEY } from "../lib/auth";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(ME_KEY, user);
      navigate((location.state as { from?: string } | null)?.from ?? "/servers", { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthShell title="Sign in to billdude">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText error={login.error} />
        <p className="text-right text-sm">
          <Link to="/forgot-password" className="text-indigo-600 hover:underline">
            Forgot password?
          </Link>
        </p>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-sm text-slate-600">
          No account?{" "}
          <Link to="/register" className="font-medium text-indigo-600 hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-2xl font-semibold text-indigo-600">billdude</p>
          <h1 className="mt-2 text-lg font-medium text-slate-800">{title}</h1>
        </div>
        <Card>{children}</Card>
      </div>
    </div>
  );
}
