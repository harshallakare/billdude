/**
 * apps/web/src/pages/CreateServer.tsx
 *
 * Usage: create-server form at /servers/new. Options come from GET /api/catalog
 * (live VHI flavors, images and networks). Submitting queues the build and
 * opens the new server's detail page, which shows progress. Selected SSH keys
 * are injected with cloud-init.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, ErrorText, Field, Input, Select } from "../components/ui";
import { api, type CreateServerInput } from "../lib/api";

export function CreateServerPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const [form, setForm] = useState<CreateServerInput>({
    name: "",
    flavorId: "",
    imageId: "",
    networkId: "",
    bootVolumeGb: 20,
    sshKeyIds: [],
  });
  const keys = useQuery({ queryKey: ["ssh-keys"], queryFn: api.listSshKeys });

  // Pre-select the first option of each list once the catalog loads.
  useEffect(() => {
    if (!catalog.data) return;
    setForm((f) => ({
      ...f,
      flavorId: f.flavorId || catalog.data.flavors[0]?.id || "",
      imageId: f.imageId || catalog.data.images[0]?.id || "",
      networkId: f.networkId || catalog.data.networks[0]?.id || "",
    }));
  }, [catalog.data]);

  const create = useMutation({
    mutationFn: () => api.createServer(form),
    onSuccess: ({ server }) => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      navigate(`/servers/${server.id}`);
    },
  });

  const image = catalog.data?.images.find((i) => i.id === form.imageId);
  const minDisk = Math.max(10, image?.minDiskGb ?? 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Create server</h1>
      <ErrorText error={catalog.error} />
      <Card>
        <form onSubmit={submit} className="space-y-5">
          <Field label="Name" hint="Letters, digits and hyphens">
            <Input
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{0,62}"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="web-1"
            />
          </Field>

          <Field label="Image">
            <Select value={form.imageId} onChange={(e) => setForm({ ...form, imageId: e.target.value })}>
              {catalog.data?.images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Size">
            <Select value={form.flavorId} onChange={(e) => setForm({ ...form, flavorId: e.target.value })}>
              {catalog.data?.flavors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} — {f.vcpus} vCPU, {(f.ramMb / 1024).toFixed(f.ramMb % 1024 ? 1 : 0)} GB RAM
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Boot disk (GB)" hint={`Minimum ${minDisk} GB for this image`}>
            <Input
              type="number"
              min={minDisk}
              max={2000}
              required
              value={form.bootVolumeGb}
              onChange={(e) => setForm({ ...form, bootVolumeGb: Number(e.target.value) })}
            />
          </Field>

          <Field label="Network">
            <Select value={form.networkId} onChange={(e) => setForm({ ...form, networkId: e.target.value })}>
              {catalog.data?.networks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {n.external ? " (public)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="SSH keys" hint="Installed for the image's default user. Password login over SSH is disabled.">
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              {keys.data?.sshKeys.length === 0 && (
                <p className="text-sm text-slate-500">
                  No keys yet —{" "}
                  <Link to="/ssh-keys" className="text-indigo-600 hover:underline">
                    add one
                  </Link>{" "}
                  or you will only be able to use the web console.
                </p>
              )}
              {keys.data?.sshKeys.map((k) => (
                <label key={k.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.sshKeyIds.includes(k.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        sshKeyIds: e.target.checked ? [...form.sshKeyIds, k.id] : form.sshKeyIds.filter((id) => id !== k.id),
                      })
                    }
                  />
                  <span className="font-medium">{k.name}</span>
                  <span className="font-mono text-xs text-slate-500">{k.fingerprint}</span>
                </label>
              ))}
            </div>
          </Field>

          <ErrorText error={create.error} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => navigate("/servers")}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || catalog.isLoading}>
              {create.isPending ? "Creating…" : "Create server"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
