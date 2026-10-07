/**
 * apps/web/src/components/Layout.tsx
 *
 * Usage: page chrome for signed-in screens (top bar + content area).
 * Used as a parent route element in App.tsx; child routes render via <Outlet />.
 */
import { Link, NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCurrentUser, useLogout } from "../lib/auth";
import { Button } from "./ui";

export function Layout() {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: api.wallet, refetchInterval: 60_000 });
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium ${isActive ? "text-indigo-600" : "text-slate-600 hover:text-slate-900"}`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold text-indigo-600">
              billdude
            </Link>
            <NavLink to="/servers" className={navClass}>
              Servers
            </NavLink>
            <NavLink to="/ssh-keys" className={navClass}>
              SSH keys
            </NavLink>
            <NavLink to="/billing" className={navClass}>
              Billing
            </NavLink>
          </div>
          <div className="flex items-center gap-3">
            {wallet.data && (
              <Link
                to="/billing"
                className={`rounded-md px-2 py-1 font-mono text-sm ${wallet.data.balance.startsWith("-") ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"}`}
              >
                {wallet.data.currency} {wallet.data.balance}
              </Link>
            )}
            <span className="text-sm text-slate-600">
              {user?.name}
              {user?.role === "admin" && <span className="ml-1 rounded bg-indigo-100 px-1.5 text-xs text-indigo-700">admin</span>}
            </span>
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      {wallet.data?.overdueSince && (
        <div className="bg-red-600 px-4 py-2 text-center text-sm text-white print:hidden">
          Your account balance is overdue.{" "}
          <Link to="/billing" className="font-semibold underline">
            Add funds
          </Link>{" "}
          to keep your servers running.
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
