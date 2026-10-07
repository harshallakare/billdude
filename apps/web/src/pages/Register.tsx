/**
 * apps/web/src/pages/Register.tsx
 *
 * Usage: customer sign-up screen at /register. Creates the account, signs in
 * and lands on /servers.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";
import { ME_KEY } from "../lib/auth";
import { AuthShell } from "./Login";

export function RegisterPage() {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: () => api.register(form.name, form.email, form.password),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(ME_KEY, user);
      navigate("/servers", { replace: true });
    },
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate();
  };

  return (
    <AuthShell title="Create your account">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoComplete="name" required value={form.name} onChange={set("name")} />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" hint="At least 10 characters">
          <Input type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={set("password")} />
        </Field>
        <ErrorText error={register.error} />
        <Button type="submit" className="w-full" disabled={register.isPending}>
          {register.isPending ? "Creating account…" : "Create account"}
        </Button>
        <p className="text-center text-sm text-slate-600">
          Already registered?{" "}
          <Link to="/login" className="font-medium text-indigo-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
