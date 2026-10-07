/**
 * apps/web/src/pages/ServerDetail.tsx
 *
 * Usage: server detail at /servers/:id with power actions, console and delete.
 * Polls every 2s while the server is changing state.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Card, ErrorText, StatusBadge } from "../components/ui";
import { api, TRANSITIONAL, type Server } from "../lib/api";

export function ServerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["server", id],
    queryFn: () => api.getServer(id),
    refetchInterval: (q) => (q.state.data && TRANSITIONAL.includes(q.state.data.server.status) ? 2_000 : false),
  });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const volumes = useQuery({ queryKey: ["volumes"], queryFn: api.volumes });

  const onChanged = (data: { server: Server }) => {
    queryClient.setQueryData(["server", id], data);
    void queryClient.invalidateQueries({ queryKey: ["servers"] });
  };

  const action = useMutation({
    mutationFn: (a: "start" | "stop" | "reboot") => api.serverAction(id, a),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteServer(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      navigate("/servers");
    },
  });
  const console = useMutation({
    mutationFn: () => api.consoleUrl(id),
    onSuccess: ({ url }) => window.open(url, "_blank", "noopener"),
  });

  if (query.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (query.error || !query.data) return <ErrorText error={query.error ?? "Server not found"} />;

  const server = query.data.server;
  const busy = TRANSITIONAL.includes(server.status) || action.isPending || remove.isPending;
  const flavor = catalog.data?.flavors.find((f) => f.id === server.flavorId);
  const image = catalog.data?.images.find((i) => i.id === server.imageId);
  const network = catalog.data?.networks.find((n) => n.id === server.networkId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{server.name}</h1>
          <StatusBadge status={server.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {server.status === "stopped" && (
            <Button disabled={busy} onClick={() => action.mutate("start")}>
              Start
            </Button>
          )}
          {server.status === "active" && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => console.mutate()}>
                Console
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => action.mutate("reboot")}>
                Reboot
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => action.mutate("stop")}>
                Stop
              </Button>
            </>
          )}
          {["active", "stopped", "error"].includes(server.status) && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete ${server.name}? Its disk will be destroyed.`)) remove.mutate();
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      <ErrorText error={action.error ?? remove.error ?? console.error} />
      {server.status === "error" && server.statusMessage && <ErrorText error={server.statusMessage} />}
      {TRANSITIONAL.includes(server.status) && (
        <p className="text-sm text-slate-500">Working on it — this page updates automatically.</p>
      )}

      <Card>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <Detail label="IPv4" value={server.ipv4 ?? "—"} mono />
          <Detail label="Image" value={image?.name ?? server.imageId} />
          <Detail
            label="Size"
            value={flavor ? `${flavor.name} — ${flavor.vcpus} vCPU, ${flavor.ramMb / 1024} GB RAM` : server.flavorId}
          />
          <Detail label="Boot disk" value={`${server.bootVolumeGb} GB`} />
          <Detail label="Network" value={network?.name ?? server.networkId} />
          <Detail label="Created" value={new Date(server.createdAt).toLocaleString()} />
          <Detail label="ID" value={server.id} mono />
        </dl>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Attached volumes</h2>
          <Link to="/volumes" className="text-sm text-indigo-600 hover:underline">
            Manage volumes
          </Link>
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          {volumes.data?.volumes.filter((v) => v.serverId === server.id).length === 0 && <li className="text-slate-500">None.</li>}
          {volumes.data?.volumes
            .filter((v) => v.serverId === server.id)
            .map((v) => (
              <li key={v.id}>
                {v.name} — {v.sizeGb} GB <span className="text-slate-500">({v.status})</span>
              </li>
            ))}
        </ul>
      </Card>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "font-medium"}>{value}</dd>
    </div>
  );
}
