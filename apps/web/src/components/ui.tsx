/**
 * apps/web/src/components/ui.tsx
 *
 * Usage: small set of styled building blocks shared by every page.
 *
 *   <Card><Field label="Name"><Input value={v} onChange={...} /></Field><Button>Save</Button></Card>
 *   <StatusBadge status={server.status} />
 *
 * Kept dependency-free on purpose; swap for shadcn/ui components later if needed.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import type { ServerStatus } from "../lib/api";

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-indigo-600 text-white hover:bg-indigo-500",
        variant === "secondary" && "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-500",
        className,
      )}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      {...props}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-slate-200 bg-white p-6 shadow-sm", className)}>{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

const STATUS_STYLES: Record<ServerStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  building: "bg-amber-100 text-amber-800",
  starting: "bg-amber-100 text-amber-800",
  stopping: "bg-amber-100 text-amber-800",
  rebooting: "bg-amber-100 text-amber-800",
  deleting: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  stopped: "bg-slate-200 text-slate-700",
  error: "bg-red-100 text-red-800",
  deleted: "bg-slate-100 text-slate-500",
};

export function StatusBadge({ status }: { status: ServerStatus }) {
  return (
    <span className={cx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLES[status])}>
      {status}
    </span>
  );
}
