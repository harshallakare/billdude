/**
 * apps/web/src/App.tsx
 *
 * Usage: top-level routes. Rendered by src/main.tsx.
 *   /login, /register          public
 *   /forgot-password, /reset-password, /verify-email   public emailed-link pages
 *   /account                   profile, email verification, password change
 *   /servers                   list (default after sign-in)
 *   /servers/new               create wizard
 *   /servers/:id               detail + power actions + console
 *   /ssh-keys                  SSH key manager
 *   /firewall                  inbound firewall rules
 *   /billing                   wallet, top-ups, transactions
 *   /billing/statements/:month monthly usage statement
 *   /support, /support/:id     support tickets
 *   /admin/*                   admin area (overview, customers, pricing, tickets, audit)
 */
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useCurrentUser } from "./lib/auth";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminAuditPage } from "./pages/admin/Audit";
import { AdminCustomerDetailPage } from "./pages/admin/CustomerDetail";
import { AdminCustomersPage } from "./pages/admin/Customers";
import { AdminOverviewPage } from "./pages/admin/Overview";
import { AdminPricingPage } from "./pages/admin/Pricing";
import { AdminTicketsPage } from "./pages/admin/Tickets";
import { AccountPage } from "./pages/Account";
import { BillingPage } from "./pages/Billing";
import { CreateServerPage } from "./pages/CreateServer";
import { FirewallPage } from "./pages/Firewall";
import { LoginPage } from "./pages/Login";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./pages/PasswordReset";
import { RegisterPage } from "./pages/Register";
import { ServerDetailPage } from "./pages/ServerDetail";
import { ServersPage } from "./pages/Servers";
import { SshKeysPage } from "./pages/SshKeys";
import { StatementPage } from "./pages/Statement";
import { SupportPage } from "./pages/Support";
import { TicketThreadPage } from "./pages/TicketThread";

function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useCurrentUser();
  const location = useLocation();
  if (isLoading) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/servers" element={<ServersPage />} />
        <Route path="/servers/new" element={<CreateServerPage />} />
        <Route path="/servers/:id" element={<ServerDetailPage />} />
        <Route path="/ssh-keys" element={<SshKeysPage />} />
        <Route path="/firewall" element={<FirewallPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/billing/statements/:month" element={<StatementPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/support/:id" element={<TicketThreadPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminOverviewPage />} />
          <Route path="customers" element={<AdminCustomersPage />} />
          <Route path="customers/:id" element={<AdminCustomerDetailPage />} />
          <Route path="pricing" element={<AdminPricingPage />} />
          <Route path="tickets" element={<AdminTicketsPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/servers" replace />} />
    </Routes>
  );
}
