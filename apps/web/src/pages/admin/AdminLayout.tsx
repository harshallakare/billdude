/**
 * apps/web/src/pages/admin/AdminLayout.tsx
 *
 * Usage: wrapper for every /admin/* page: refuses non-admins and renders the
 * admin sub-navigation. Child routes render through <Outlet />.
 */
import { Navigate, NavLink, Outlet } from "react-router-dom";
import { useCurrentUser } from "../../lib/auth";

const TABS = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/customers", label: "Customers" },
  { to: "/admin/pricing", label: "Pricing" },
  { to: "/admin/tickets", label: "Tickets" },
  { to: "/admin/audit", label: "Audit log" },
];

export function AdminLayout() {
  const { data: user } = useCurrentUser();
  if (user?.role !== "admin") return <Navigate to="/servers" replace />;

  return (
    <div className="space-y-6">
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                isActive ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-600 hover:text-slate-900"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
