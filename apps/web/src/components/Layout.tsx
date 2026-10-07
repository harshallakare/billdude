/**
 * apps/web/src/components/Layout.tsx
 *
 * Usage: page chrome for signed-in screens (top bar + content area).
 * Used as a parent route element in App.tsx; child routes render via <Outlet />.
 */
import { Link, NavLink, Outlet } from "react-router-dom";
import { useCurrentUser, useLogout } from "../lib/auth";
import { Button } from "./ui";

export function Layout() {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
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
          </div>
          <div className="flex items-center gap-3">
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
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
