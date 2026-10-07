/**
 * apps/web/src/pages/Volumes.tsx
 *
 * Usage: data volumes at /volumes — create extra disks, attach them to a
 * server, detach and delete. Polls while any volume is changing state.
 * After attaching, the disk appears in the server as e.g. /dev/vdb (format and mount it there).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, Field, Input, Select } from "../components/ui";
import { api, VOLUME_TRANSITIONAL, type Volume } from "../lib/api";

const STATUS_STYLE: Record<string, string> = {
  available: "bg-slate-200 text-slate-700",
  attached: "bg-emerald-100 text-emerald-800",
  error: "bg-red-100 text-red-800",
};

export function VolumesPage() {
  const queryClient = useQueryClient();
  const volumes = useQuery({
    queryKey: ["volumes"],
    queryFn: api.volumes,
    refetchInterval: (q) => (q.state.data?.volumes.some((v) => VOLUME_TRANSITIONAL.includes(v.status)) ? 2_000 : false),
  });
  const servers = useQuery({ queryKey: ["servers", false], queryFn: () => api.listServers(false) });
  const pricing = useQuery({ queryKey: ["pricing"], queryFn: api.pricing, staleTime: 60_000 });
  const [name, setName] = useState("");
  const [sizeGb, setSizeGb] = useState(50);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["volumes"] });
    void queryClient.invalidateQueries({ queryKey: ["quotas"] });
  };
  const create = useMutation({
    mutationFn: () => api.createVolume(name, sizeGb),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });
  const attach = useMutation({ mutationFn: (v: { id: string; serverId: string }) => api.attachVolume(v.id, v.serverId), onSuccess: refresh });
  const detach = useMutation({ mutationFn: api.detachVolume, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteVolume, onSuccess: refresh });

  const usable = servers.data?.servers.filter((s) => s.status === "active" || s.status === "stopped") ?? [];
  const monthly = pricing.data ? (Number(pricing.data.storageGbMonthly) * sizeGb).toFixed(2) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Volumes</h1>
      <Card>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-4">
          <Field label="Name">
            <Input required pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{0,62}" value={name} onChange={(e) => setName(e.target.value)} placeholder="data-1" />
          </Field>
          <Field label="Size (GB)">
            <Input type="number" min={1} max={4000} required value={sizeGb} onChange={(e) => setSizeGb(Number(e.target.value))} />
          </Field>
          <div className="flex items-end text-sm text-slate-600">
            {monthly && (
              <span>
                ≈ {pricing.data!.currency} {monthly}/month
              </span>
            )}
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full" disabled={create.isPending}>
              Create volume
            </Button>
          </div>
        </form>
        <div className="mt-3">
          <ErrorText error={create.error ?? attach.error ?? detach.error ?? remove.error} />
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attached to</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {volumes.data?.volumes.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No volumes yet.
                </td>
              </tr>
            )}
            {volumes.data?.volumes.map((v) => (
              <VolumeRow
                key={v.id}
                volume={v}
                servers={usable}
                busy={attach.isPending || detach.isPending || remove.isPending}
                onAttach={(serverId) => attach.mutate({ id: v.id, serverId })}
                onDetach={() => detach.mutate(v.id)}
                onDelete={() => window.confirm(`Delete volume ${v.name}? Its data will be destroyed.`) && remove.mutate(v.id)}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function VolumeRow({
  volume: v,
  servers,
  busy,
  onAttach,
  onDetach,
  onDelete,
}: {
  volume: Volume;
  servers: { id: string; name: string }[];
  busy: boolean;
  onAttach: (serverId: string) => void;
  onDetach: () => void;
  onDelete: () => void;
}) {
  const [target, setTarget] = useState("");
  return (
    <tr>
      <td className="px-4 py-3 font-medium">{v.name}</td>
      <td className="px-4 py-3">{v.sizeGb} GB</td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[v.status] ?? "bg-amber-100 text-amber-800"}`}>
          {v.status}
        </span>
        {v.statusMessage && <p className="mt-1 text-xs text-red-600">{v.statusMessage}</p>}
      </td>
      <td className="px-4 py-3">
        {v.serverId ? (
          <Link to={`/servers/${v.serverId}`} className="text-indigo-600 hover:underline">
            {v.serverName}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        {v.status === "available" && (
          <span className="inline-flex gap-2">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Attach to…</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Button variant="secondary" disabled={!target || busy} onClick={() => onAttach(target)}>
              Attach
            </Button>
            <Button variant="danger" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          </span>
        )}
        {v.status === "attached" && (
          <Button variant="secondary" disabled={busy} onClick={onDetach}>
            Detach
          </Button>
        )}
        {v.status === "error" && (
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
        )}
      </td>
    </tr>
  );
}
