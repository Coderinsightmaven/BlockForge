import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileJson, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Me, Template, TemplateImportPreview, TemplateSummary } from "@blockforge/contracts";
import { templatesApi } from "@/lib/api/servers-api";
import { describeError, fieldErrorsFrom } from "@/lib/api/errors";
import { toastError, useApiMutation } from "@/lib/mutations";
import { hasGlobal } from "@/lib/permissions";
import { templateQuery, templatesQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

/** Max egg JSON accepted from paste/upload (eggs are a few KB; install scripts ≤ 64 KiB). */
export const MAX_EGG_BYTES = 512 * 1024;

/** Parse pasted/uploaded egg JSON into an object, with a user-facing error. */
export function parseEggJson(text: string): { egg: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { egg: null, error: "Paste the egg JSON or choose a file." };
  if (text.length > MAX_EGG_BYTES)
    return { egg: null, error: "That file is too large to be an egg (max 512 KiB)." };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return { egg: null, error: "The JSON must be an object (an egg export)." };
    return { egg: v as Record<string, unknown>, error: null };
  } catch (e) {
    return { egg: null, error: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}` };
  }
}

export function hasBlockingIssues(
  preview: Pick<TemplateImportPreview, "issues" | "template"> | null,
): boolean {
  return !preview || !preview.template || preview.issues.some((i) => i.severity === "error");
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AllowlistHelp({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  const entries = [...new Set(images.map((i) => `${i.replace(/[:@].*$/, "")}:*`))];
  return (
    <Callout tone="warning" title="Images not on the default agent allowlist">
      <p>
        Agents only run images on their own allowlist; servers using these will fail to start until each node
        allows them:
      </p>
      <ul className="my-1 list-disc pl-5 font-mono text-xs">
        {images.map((i) => (
          <li key={i} className="break-all">
            {i}
          </li>
        ))}
      </ul>
      <p>
        On every node that should run this template, add the entries below to{" "}
        <code className="font-mono">imageAllowlist</code> in the agent's{" "}
        <code className="font-mono">agent.json</code> and restart the agent. The control plane cannot change
        it remotely.
      </p>
      <pre className="mt-1 overflow-auto rounded bg-muted p-2 font-mono text-xs">
        {JSON.stringify({ imageAllowlist: entries }, null, 2)}
      </pre>
    </Callout>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existing: TemplateSummary[];
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [category, setCategory] = useState("Imported");
  const [game, setGame] = useState<"auto" | "minecraft-java" | "minecraft-proxy" | "other">("auto");
  const [replaceKey, setReplaceKey] = useState<string>("__new");
  const [preview, setPreview] = useState<TemplateImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setText("");
    setPreview(null);
    setError(null);
    setReplaceKey("__new");
  }, [open]);

  const body = () => {
    const { egg, error: err } = parseEggJson(text);
    if (err || !egg) {
      setError(err);
      return null;
    }
    if (!category.trim()) {
      setError("Enter a category.");
      return null;
    }
    return {
      egg,
      category: category.trim(),
      ...(game !== "auto" ? { game } : {}),
      ...(replaceKey !== "__new" ? { replaceKey } : {}),
    };
  };
  const previewM = useApiMutation({
    mutationFn: templatesApi.importPreview,
    silentError: true,
    onError: (e) => setError(describeError(e).title),
    onSuccess: (p) => {
      setError(null);
      setPreview(p);
    },
  });
  const importM = useApiMutation({
    mutationFn: templatesApi.import,
    success: (r) => `Imported “${r.template.name}”`,
    errorTitle: "Import failed",
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.templates.all });
      onOpenChange(false);
    },
  });
  const eggs = existing.filter((t) => t.kind === "egg");
  const blocked = hasBlockingIssues(preview);
  const counts = preview
    ? (["error", "warning", "info"] as const).map(
        (sev) => [sev, preview.issues.filter((i) => i.severity === sev).length] as const,
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !importM.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import an egg</DialogTitle>
          <DialogDescription>
            Pterodactyl (PTDL_v1/v2) or Pelican (PLCN_v1) egg JSON. Install scripts run as root inside an
            install container, so only import eggs you trust.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden />
            Choose file…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > MAX_EGG_BYTES) {
                setError("That file is too large to be an egg (max 512 KiB).");
                return;
              }
              setText(await f.text());
              setPreview(null);
            }}
          />
          <span className="text-xs text-muted-foreground">or paste the JSON below</span>
        </div>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          rows={8}
          className="font-mono text-xs"
          spellCheck={false}
          aria-label="Egg JSON"
          placeholder='{ "meta": { "version": "PTDL_v2" }, "name": "…" }'
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category" hint="Groups templates in the wizard (like a nest).">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Game features">
            <Select
              value={game}
              onValueChange={setGame}
              options={[
                { value: "auto", label: "Detect" },
                { value: "minecraft-java", label: "Minecraft (Java)" },
                { value: "minecraft-proxy", label: "Minecraft proxy" },
                { value: "other", label: "Other game" },
              ]}
            />
          </Field>
          <Field label="Replace">
            <Select
              value={replaceKey}
              onValueChange={setReplaceKey}
              options={[
                { value: "__new", label: "Create a new template" },
                ...eggs.map((t) => ({ value: t.key, label: `Replace ${t.name}` })),
              ]}
            />
          </Field>
        </div>
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        {preview ? (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <FileJson className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-medium">{preview.template?.name ?? "Unreadable egg"}</span>
              {preview.template?.sourceFormat ? (
                <Badge variant="outline">{preview.template.sourceFormat}</Badge>
              ) : null}
              {counts.map(([sev, n]) =>
                n ? (
                  <Badge key={sev} tone={sev === "error" ? "danger" : sev === "warning" ? "warning" : "info"}>
                    {n} {sev}
                    {n === 1 ? "" : "s"}
                  </Badge>
                ) : null,
              )}
            </div>
            {preview.template ? (
              <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Images</dt>
                  <dd className="font-mono break-all">
                    {preview.template.dockerImages.map((d) => d.image).join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Variables</dt>
                  <dd>{preview.template.variables.length}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Startup</dt>
                  <dd className="font-mono break-all">{preview.template.startup || "—"}</dd>
                </div>
              </dl>
            ) : null}
            {preview.issues.length ? (
              <ul className="flex max-h-56 flex-col gap-1 overflow-auto text-xs">
                {preview.issues.map((i, n) => (
                  <li key={n} className="flex gap-2">
                    <Badge
                      tone={i.severity === "error" ? "danger" : i.severity === "warning" ? "warning" : "info"}
                      className="shrink-0"
                    >
                      {i.severity}
                    </Badge>
                    <span className="min-w-0 break-words">
                      {i.message}
                      {i.path ? <code className="ml-1 font-mono text-muted-foreground">{i.path}</code> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No issues found.</p>
            )}
            <AllowlistHelp images={preview.imagesNeedingAllowlist} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importM.isPending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            loading={previewM.isPending}
            onClick={() => {
              const b = body();
              if (b) previewM.mutate(b);
            }}
          >
            Check
          </Button>
          <Button
            disabled={blocked}
            title={blocked ? "Check the egg first; errors block the import" : undefined}
            loading={importM.isPending}
            onClick={() => {
              const b = body();
              if (b) importM.mutate(b);
            }}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function linesToList(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function EditDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({ ...templateQuery(id ?? ""), enabled: !!id });
  const t = q.data;
  const builtin = t?.source === "builtin";
  const [form, setForm] = useState<Record<string, string>>({});
  const [readOnlyRootfs, setReadOnlyRootfs] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!t) return;
    setForm({
      name: t.name,
      description: t.description,
      category: t.category,
      startup: t.startup,
      startupDone: t.startupDone.join("\n"),
      fileDenylist: t.fileDenylist.join("\n"),
      images: t.dockerImages.map((d) => `${d.label}=${d.image}`).join("\n"),
      stop: t.stop.type === "command" ? t.stop.command : `^${t.stop.signal}`,
      dataMountPath: t.runtime.dataMountPath,
    });
    setReadOnlyRootfs(t.runtime.readOnlyRootfs);
    setErrors({});
  }, [t]);
  const save = useApiMutation({
    mutationFn: (body: Parameters<typeof templatesApi.update>[1]) => templatesApi.update(id!, body),
    success: "Template saved",
    errorTitle: "Could not save the template",
    onSuccess: async (saved: Template) => {
      queryClient.setQueryData(qk.templates.detail(saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: qk.templates.list });
      onClose();
    },
  });
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!t) return;
    const next: Record<string, string> = {};
    if (!form.name?.trim()) next.name = "Required.";
    if (!form.category?.trim()) next.category = "Required.";
    const body: Parameters<typeof templatesApi.update>[1] = {
      name: form.name?.trim(),
      description: form.description ?? "",
      category: form.category?.trim(),
    };
    if (!builtin) {
      const images = linesToList(form.images ?? "").map((l) => {
        const eq = l.indexOf("=");
        return eq > 0
          ? { label: l.slice(0, eq).trim(), image: l.slice(eq + 1).trim() }
          : { label: l, image: l };
      });
      if (images.some((i) => !i.image)) next.images = "One image per line, optionally “Label=image:tag”.";
      const stopRaw = (form.stop ?? "").trim();
      const sig = /^\^(SIGINT|SIGTERM|SIGQUIT|SIGKILL|C)$/.exec(stopRaw);
      if (!stopRaw) next.stop = "Enter a stop command, or ^SIGTERM / ^C for a signal.";
      Object.assign(body, {
        startup: form.startup ?? "",
        startupDone: linesToList(form.startupDone ?? ""),
        fileDenylist: linesToList(form.fileDenylist ?? ""),
        dockerImages: images,
        stop: sig
          ? { type: "signal", signal: sig[1] === "C" ? "SIGINT" : sig[1] }
          : { type: "command", command: stopRaw },
        runtime: {
          dataMountPath: form.dataMountPath === "/data" ? "/data" : "/home/container",
          readOnlyRootfs,
        },
      });
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    save.mutate(body, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-3xl">
        {q.isPending ? (
          <Skeleton className="h-64" />
        ) : q.isError || !t ? (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            title="Could not load the template"
            compact
          />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Edit {t.name}</DialogTitle>
              <DialogDescription>
                {builtin
                  ? "Built-in template: only the name, description and category can be changed."
                  : `${t.sourceFormat ?? "Imported"} egg${t.author ? ` by ${t.author}` : ""} · used by ${t.serverCount} server(s). Changes apply to servers on their next start.`}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" error={errors.name}>
                <Input value={form.name ?? ""} onChange={(e) => set("name")(e.target.value)} maxLength={80} />
              </Field>
              <Field label="Category" error={errors.category}>
                <Input
                  value={form.category ?? ""}
                  onChange={(e) => set("category")(e.target.value)}
                  maxLength={80}
                />
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Textarea
                  value={form.description ?? ""}
                  onChange={(e) => set("description")(e.target.value)}
                  rows={2}
                  maxLength={4096}
                />
              </Field>
              {!builtin ? (
                <>
                  <Field
                    label="Docker images"
                    error={errors.images ?? errors.dockerImages}
                    hint="One per line: Label=image:tag"
                    className="sm:col-span-2"
                  >
                    <Textarea
                      value={form.images ?? ""}
                      onChange={(e) => set("images")(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Startup command"
                    error={errors.startup}
                    hint="{{VARIABLE}} placeholders are substituted."
                    className="sm:col-span-2"
                  >
                    <Textarea
                      value={form.startup ?? ""}
                      onChange={(e) => set("startup")(e.target.value)}
                      rows={2}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Started when the console prints"
                    error={errors.startupDone}
                    hint="One string per line (any match)."
                  >
                    <Textarea
                      value={form.startupDone ?? ""}
                      onChange={(e) => set("startupDone")(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="Files users may not touch"
                    error={errors.fileDenylist}
                    hint="One path or pattern per line."
                  >
                    <Textarea
                      value={form.fileDenylist ?? ""}
                      onChange={(e) => set("fileDenylist")(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="Stop"
                    error={errors.stop}
                    hint="A console command, or ^SIGTERM / ^C (SIGINT)."
                  >
                    <Input
                      value={form.stop ?? ""}
                      onChange={(e) => set("stop")(e.target.value)}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Data directory in the container">
                    <Select
                      value={form.dataMountPath === "/data" ? "/data" : "/home/container"}
                      onValueChange={set("dataMountPath")}
                      options={[
                        { value: "/home/container", label: "/home/container (eggs, yolks)" },
                        { value: "/data", label: "/data" },
                      ]}
                    />
                  </Field>
                  <label className="flex items-start gap-3 sm:col-span-2">
                    <Switch checked={readOnlyRootfs} onCheckedChange={setReadOnlyRootfs} className="mt-0.5" />
                    <span className="text-sm">
                      Read-only image filesystem
                      <span className="block text-xs text-muted-foreground">
                        Safer; turn off only for images that write outside their data directory.
                      </span>
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Variables ({t.variables.length}), config-file rules ({t.configFiles.length}) and the
                    install script come from the egg — re-import it to change them.
                  </p>
                </>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TemplatesPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const allowed = hasGlobal(me, "templates.view");
  const canManage = hasGlobal(me, "templates.manage");
  const q = useQuery({ ...templatesQuery, enabled: allowed });
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const remove = useApiMutation({
    mutationFn: (t: TemplateSummary) => templatesApi.remove(t.id),
    success: "Template deleted",
    errorTitle: "Could not delete the template",
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: qk.templates.all });
    },
  });
  const groups = useMemo(() => {
    const m = new Map<string, TemplateSummary[]>();
    for (const t of q.data ?? []) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [q.data]);

  if (!allowed) return <NoPermission what="view server templates" />;
  const exportOne = async (t: TemplateSummary) => {
    try {
      downloadJson(`${t.key}.json`, await templatesApi.export(t.id));
    } catch (e) {
      toastError(e, "Export failed");
    }
  };

  return (
    <>
      <PageHeader
        title="Templates"
        description="Built-in Minecraft templates and imported eggs that servers are created from."
        actions={
          canManage ? (
            <Button onClick={() => setImportOpen(true)}>
              <Upload aria-hidden />
              Import egg
            </Button>
          ) : null
        }
      />
      {q.isPending ? (
        <Card>
          <TableSkeleton columns={5} />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load templates" />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileJson}
            title="No templates"
            description="Import a Pterodactyl or Pelican egg to support more games."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(([cat, items]) => (
            <Card key={cat}>
              <CardHeader>
                <CardTitle>{cat}</CardTitle>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Template</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Images</TableHead>
                    <TableHead className="text-right">Servers</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((t) => {
                    const deletable = t.kind === "egg" && t.serverCount === 0;
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="max-w-md">
                          <div className="font-medium">{t.name}</div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">{t.description}</div>
                        </TableCell>
                        <TableCell>
                          {t.kind === "egg" ? (
                            <Badge variant="outline">Egg</Badge>
                          ) : (
                            <Badge tone="info">Built-in</Badge>
                          )}
                          <div className="mt-0.5 text-[11px] text-muted-foreground">{t.game}</div>
                        </TableCell>
                        <TableCell className="max-w-64 font-mono text-[11px] break-all">
                          {t.dockerImages.length
                            ? t.dockerImages.map((d) => d.image).join(", ")
                            : "Java by version"}
                        </TableCell>
                        <TableCell className="text-right">{t.serverCount}</TableCell>
                        <TableCell>
                          {canManage ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Edit ${t.name}`}
                                onClick={() => setEditing(t.id)}
                              >
                                <Pencil aria-hidden />
                              </Button>
                              {t.kind === "egg" ? (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Export ${t.name}`}
                                  onClick={() => void exportOne(t)}
                                >
                                  <Download aria-hidden />
                                </Button>
                              ) : null}
                              {t.kind === "egg" ? (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Delete ${t.name}`}
                                  disabled={!deletable}
                                  title={deletable ? undefined : "In use by servers"}
                                  className={cn(!deletable && "opacity-40")}
                                  onClick={() => setDeleting(t)}
                                >
                                  <Trash2 aria-hidden />
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          ))}
        </div>
      )}
      {canManage ? (
        <>
          <ImportDialog open={importOpen} onOpenChange={setImportOpen} existing={q.data ?? []} />
          <EditDialog id={editing} onClose={() => setEditing(null)} />
        </>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="The template is removed. Export it first if you may need it again."
        confirmLabel="Delete template"
        destructive
        confirmText={deleting?.name}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}
