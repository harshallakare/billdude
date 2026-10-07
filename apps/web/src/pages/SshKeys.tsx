/**
 * apps/web/src/pages/SshKeys.tsx
 *
 * Usage: SSH key manager at /ssh-keys. Customers paste public keys here and
 * pick them when creating a server. Deleting a key does not affect servers
 * that were already created with it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { api } from "../lib/api";

export function SshKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["ssh-keys"], queryFn: api.listSshKeys });
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
  const add = useMutation({
    mutationFn: () => api.addSshKey(name, publicKey),
    onSuccess: () => {
      setName("");
      setPublicKey("");
      void refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteSshKey, onSuccess: () => void refresh() });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">SSH keys</h1>

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name">
            <Input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop" />
          </Field>
          <Field label="Public key" hint="Paste the contents of ~/.ssh/id_ed25519.pub (or id_rsa.pub)">
            <textarea
              required
              rows={3}
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAAC3Nza… you@laptop"
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </Field>
          <ErrorText error={add.error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Adding…" : "Add key"}
            </Button>
          </div>
        </form>
      </Card>

      <ErrorText error={keys.error ?? remove.error} />
      <Card className="divide-y divide-slate-100 p-0">
        {keys.data?.sshKeys.length === 0 && <p className="p-6 text-sm text-slate-500">No SSH keys yet.</p>}
        {keys.data?.sshKeys.map((k) => (
          <div key={k.id} className="flex items-center justify-between gap-4 px-6 py-4">
            <div className="min-w-0">
              <p className="font-medium">{k.name}</p>
              <p className="truncate font-mono text-xs text-slate-500">{k.fingerprint}</p>
            </div>
            <Button
              variant="secondary"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove SSH key "${k.name}"?`)) remove.mutate(k.id);
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
