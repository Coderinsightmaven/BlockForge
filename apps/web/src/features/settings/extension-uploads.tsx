import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ExtensionUploadSettings } from "@blockforge/contracts";
import { extensionUploadSettingsApi } from "@/lib/api/phase4b-api";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/** Settings → Plugin & mod uploads (`extensions.uploads`, settings.manage). */
export default function ExtensionUploadsCard() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: qk.settings.extensionUploads,
    queryFn: ({ signal }) => extensionUploadSettingsApi.get(signal),
  });
  const [form, setForm] = useState<ExtensionUploadSettings>({ allowed: true, requireMetadata: true });
  useEffect(() => {
    if (q.data) setForm(q.data.value);
  }, [q.data]);
  const dirty =
    !!q.data &&
    (form.allowed !== q.data.value.allowed || form.requireMetadata !== q.data.value.requireMetadata);
  const save = useApiMutation({
    mutationFn: (value: ExtensionUploadSettings) => extensionUploadSettingsApi.put(value),
    success: "Upload policy saved",
    errorTitle: "Could not save the upload policy",
    onSuccess: (view) => {
      queryClient.setQueryData(qk.settings.extensionUploads, view);
    },
  });
  if (q.isPending) return <Skeleton className="h-40 w-full" />;
  if (q.isError)
    return (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the upload policy" />
    );
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Plugin &amp; mod uploads</CardTitle>
          <CardDescription>
            Who may upload their own .jar files in a server's Plugins &amp; mods tab.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex max-w-xl flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch
            id="uploads-allowed"
            checked={form.allowed}
            onCheckedChange={(v) => setForm((f) => ({ ...f, allowed: v }))}
            className="mt-0.5"
          />
          <div>
            <Label htmlFor="uploads-allowed">Allow uploads</Label>
            <p className="text-xs text-muted-foreground">
              Off: only Modrinth installs. Users with the plugin/mod manage permission can otherwise upload
              jars.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            id="uploads-metadata"
            checked={form.requireMetadata}
            disabled={!form.allowed}
            onCheckedChange={(v) => setForm((f) => ({ ...f, requireMetadata: v }))}
            className="mt-0.5"
          />
          <div>
            <Label htmlFor="uploads-metadata">Require plugin/mod metadata</Label>
            <p className="text-xs text-muted-foreground">
              Refuse jars that declare no plugin or mod (plugin.yml, fabric.mod.json, mods.toml, …).
            </p>
          </div>
        </div>
        <Callout tone="info">
          This only governs the upload button. Users who may write files or use SFTP can still place jars
          directly; those show up as “Unknown” after the next scan.
        </Callout>
        <Button
          className="self-start"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate(form)}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
