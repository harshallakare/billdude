/**
 * apps/web/src/pages/admin/Pricing.tsx
 *
 * Usage: price list at /admin/pricing. Every flavor shows its effective
 * hourly price; admins can override one (exact decimal) or reset it to the
 * vCPU/RAM formula configured in the environment.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorText, Input } from "../../components/ui";
import { api } from "../../lib/api";

export function AdminPricingPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["admin", "pricing"], queryFn: api.admin.pricing });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "pricing"] });
    void queryClient.invalidateQueries({ queryKey: ["pricing"] });
  };
  const save = useMutation({
    mutationFn: ({ flavorId, hourly }: { flavorId: string; hourly: string }) => api.admin.setFlavorPrice(flavorId, hourly),
    onSuccess: (_d, v) => {
      setDrafts(({ [v.flavorId]: _, ...rest }) => rest);
      refresh();
    },
  });
  const reset = useMutation({ mutationFn: api.admin.resetFlavorPrice, onSuccess: refresh });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <ErrorText error={error ?? save.error ?? reset.error} />
      {data && (
        <p className="text-sm text-slate-600">
          Default formula: {data.currency} {data.defaults.vcpuHourly} per vCPU-hour + {data.currency} {data.defaults.ramGbHourly} per GB
          RAM-hour. Boot disks: {data.currency} {data.defaults.storageGbMonthly} per GB-month. Defaults come from the
          BILLING_* environment variables.
        </p>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Flavor</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3 text-right">Monthly</th>
              <th className="px-4 py-3">Hourly ({data?.currency})</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.flavors.map((f) => {
              const draft = drafts[f.flavorId];
              return (
                <tr key={f.flavorId}>
                  <td className="px-4 py-3 font-medium">
                    {f.name}
                    {f.override && <span className="ml-2 text-xs text-indigo-600">custom</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {f.vcpus} vCPU · {f.ramMb / 1024} GB
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{f.monthly}</td>
                  <td className="w-40 px-4 py-3">
                    <Input
                      value={draft ?? f.hourlyExact.replace(/0+$/, "").replace(/\.$/, ".00")}
                      onChange={(e) => setDrafts({ ...drafts, [f.flavorId]: e.target.value })}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <Button
                      className="mr-2"
                      disabled={draft === undefined || save.isPending}
                      onClick={() => save.mutate({ flavorId: f.flavorId, hourly: draft! })}
                    >
                      Save
                    </Button>
                    {f.override && (
                      <Button variant="secondary" disabled={reset.isPending} onClick={() => reset.mutate(f.flavorId)}>
                        Reset
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
