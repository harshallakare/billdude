/**
 * apps/web/src/App.tsx
 *
 * Usage: top-level routes. Rendered by src/main.tsx.
 *   /login, /register          public
 *   /servers                   list (default after sign-in)
 *   /servers/new               create wizard
 *   /servers/:id               detail + power actions + console
 *   /ssh-keys                  SSH key manager
 */
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useCurrentUser } from "./lib/auth";
import { CreateServerPage } from "./pages/CreateServer";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { ServerDetailPage } from "./pages/ServerDetail";
import { ServersPage } from "./pages/Servers";
import { SshKeysPage } from "./pages/SshKeys";

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
      </Route>
      <Route path="*" element={<Navigate to="/servers" replace />} />
    </Routes>
  );
}
