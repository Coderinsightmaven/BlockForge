import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import type { Server, ServerStartup } from "@blockforge/contracts";
import { serversApi } from "@/lib/api/servers-api";
import { describeError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { serverStartupQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { serverActionable } from "@/lib/server-permissions";
import { unsupportedRules, validateVariableValue } from "@/lib/variable-rules";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { VariableInput } from "../variable-input";

type Variable = ServerStartup["variables"][number];

function VariableCard({
  server,
  variable,
  canEdit,
}: {
  server: Server;
  variable: Variable;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [value, setValue] = useState(variable.value ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(variable.value ?? ""), [variable.value]);
  const editable = canEdit && variable.editable && variable.value !== null;
  const dirty = value !== (variable.value ?? "");
  const save = useApiMutation({
    mutationFn: (v: string) => serversApi.updateVariable(server.id, variable.envName, v),
    success: `${variable.name} saved — applies on next start`,
    errorTitle: `Could not save ${variable.name}`,
    silentError: true,
    onError: (err) => setError(describeError(err).title),
    onSuccess: (startup) => {
      setError(null);
      queryClient.setQueryData(qk.server(server.id).startup, startup);
    },
  });
  const submit = () => {
    const err = validateVariableValue(variable, value);
    setError(err);
    if (!err) save.mutate(value);
  };
  const unchecked = unsupportedRules(variable.rules);
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-1">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-sm">
            {variable.name}
          </Label>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <code className="rounded bg-muted px-1 font-mono text-[11px]">{variable.envName}</code>
            {!variable.editable ? <Badge variant="outline">Read-only</Badge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        {variable.value === null ? (
          <p className="text-sm text-muted-foreground">Hidden by the template.</p>
        ) : (
          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="min-w-0 flex-1">
              <VariableInput
                id={id}
                rules={variable.rules}
                value={value}
                onChange={(v) => {
                  setValue(v);
                  setError(null);
                }}
                disabled={!editable || save.isPending}
                invalid={!!error}
                describedBy={`${id}-desc`}
              />
            </div>
            {editable ? (
              <Button
                type="submit"
                size="sm"
                variant={dirty ? "default" : "outline"}
                disabled={!dirty}
                loading={save.isPending}
              >
                Save
              </Button>
            ) : null}
          </form>
        )}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {variable.description ? (
          <p id={`${id}-desc`} className="text-xs whitespace-pre-line text-muted-foreground">
            {variable.description}
          </p>
        ) : null}
        <p className="mt-auto text-[11px] text-muted-foreground">
          Rules: <code className="font-mono break-all">{variable.rules}</code>
          {unchecked.length ? ` (server-checked only: ${unchecked.join(", ")})` : ""}
          {variable.defaultValue ? (
            <>
              {" "}
              · default <code className="font-mono break-all">{variable.defaultValue}</code>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

export default function StartupTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const q = useQuery(serverStartupQuery(server.id));
  const canEdit = serverActionable(server, "servers.startup.edit");
  const canImage = serverActionable(server, "servers.startup.image");
  const image = useApiMutation({
    mutationFn: (img: string) => serversApi.updateImage(server.id, img),
    success: "Docker image changed — applies on next start",
    errorTitle: "Could not change the image",
    onSuccess: (startup) => {
      queryClient.setQueryData(qk.server(server.id).startup, startup);
      void queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) });
    },
  });

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !q.data)
    return (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load startup settings" />
    );
  const st = q.data;
  const visibleVars = [...st.variables];

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Startup command</CardTitle>
            <CardDescription>
              {st.startupCommand !== null
                ? "Variables are substituted when the server starts; hidden values are masked."
                : "Built-in template: the launch command is generated from the software, version and JVM settings."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {st.resolvedStartup ? (
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                {st.resolvedStartup}
              </pre>
              <CopyButton value={st.resolvedStartup} label="Copy startup command" />
            </div>
          ) : null}
          {st.minecraft ? (
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Software</dt>
                <dd className="capitalize">{st.minecraft.software}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Version / build</dt>
                <dd className="font-mono text-xs">
                  {st.minecraft.version} · {st.minecraft.build ?? "latest stable"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Java / heap</dt>
                <dd>
                  Java {st.minecraft.javaMajor ?? "auto"} · {formatBytes(st.minecraft.heapMaxBytes)} max heap
                </dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-xs text-muted-foreground">JVM flags ({st.minecraft.jvmPreset} preset)</dt>
                <dd className="font-mono text-xs break-all">
                  {st.minecraft.jvmArgs.length ? st.minecraft.jvmArgs.join(" ") : "—"}
                </dd>
              </div>
            </dl>
          ) : null}
          {st.dockerImages.length > 0 ? (
            <div className="flex max-w-md flex-col gap-1.5">
              <Label htmlFor="startup-image">Docker image</Label>
              <Select
                id="startup-image"
                value={st.dockerImage}
                onValueChange={(v) => v !== st.dockerImage && image.mutate(v)}
                disabled={!canImage || image.isPending || st.dockerImages.length < 2}
                options={st.dockerImages.map((d) => ({ value: d.image, label: `${d.label} — ${d.image}` }))}
              />
              {!canImage && st.dockerImages.length > 1 ? (
                <p className="text-xs text-muted-foreground">
                  You don't have permission to change the image.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Image: <code className="font-mono">{st.dockerImage}</code>
            </p>
          )}
        </CardContent>
      </Card>
      {!canEdit && visibleVars.some((v) => v.editable) ? (
        <Callout tone="info">
          You can view these variables but need the “Edit variables” permission to change them.
        </Callout>
      ) : null}
      {visibleVars.length === 0 ? (
        st.templateKind === "egg" ? (
          <p className="text-sm text-muted-foreground">This template has no visible variables.</p>
        ) : null
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleVars.map((v) => (
            <VariableCard key={v.envName} server={server} variable={v} canEdit={canEdit} />
          ))}
        </div>
      )}
    </div>
  );
}
