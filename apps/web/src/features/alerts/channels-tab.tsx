import { useQuery } from "@tanstack/react-query";
import { Mail, MessageSquare, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { UpsertNotificationChannelRequest } from "@blockforge/contracts";
import type { NotificationChannel as NotificationChannelSchema } from "@blockforge/contracts";
import { alertsApi } from "@/lib/api/endpoints";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { channelsQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type Channel = z.infer<typeof NotificationChannelSchema>;
type ChannelKind = Channel["kind"];
type ChannelBody = z.input<typeof UpsertNotificationChannelRequest>;

const KIND_META: Record<ChannelKind, { label: string; icon: typeof Mail }> = {
  discord: { label: "Discord webhook", icon: MessageSquare },
  webhook: { label: "Generic webhook", icon: Webhook },
  email: { label: "Email", icon: Mail },
};

const EmailList = z.array(z.email());

/** Webhook URLs must be absolute http(s); Discord requires https. The control plane re-validates (SSRF). */
export function validateWebhookUrl(kind: ChannelKind, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a full URL, e.g. https://…";
  }
  if (kind === "discord" && url.protocol !== "https:") return "Discord webhooks must use https://.";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http:// or https:// URL.";
  if (url.username || url.password) return "Do not put credentials in the URL.";
  return null;
}

export function parseRecipients(raw: string): { to: string[]; error: string | null } {
  const to = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (to.length === 0) return { to, error: "Add at least one recipient." };
  const ok = EmailList.safeParse(to);
  if (!ok.success) {
    const bad = to.filter((e) => !z.email().safeParse(e).success);
    return { to, error: `Not a valid email address: ${bad.join(", ")}` };
  }
  return { to, error: null };
}

function recipientsOf(c: Channel): string[] {
  const to = c.config.to;
  return Array.isArray(to) ? to.filter((x): x is string => typeof x === "string") : [];
}

function ChannelDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channel: Channel | null;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("discord");
  const [enabled, setEnabled] = useState(true);
  // Write-only: the stored URL is never sent to the browser, so this always starts empty.
  const [url, setUrl] = useState("");
  const [recipients, setRecipients] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setKind(channel?.kind ?? "discord");
    setEnabled(channel?.enabled ?? true);
    setUrl("");
    setRecipients(channel ? recipientsOf(channel).join(", ") : "");
    setErrors({});
  }, [open, channel]);

  const save = useApiMutation({
    mutationFn: (b: ChannelBody) =>
      channel ? alertsApi.updateChannel(channel.id, b) : alertsApi.createChannel(b),
    success: channel ? "Channel saved" : "Channel created",
    errorTitle: channel ? "Could not save channel" : "Could not create channel",
    // The body may carry the webhook URL (a secret).
    sensitive: true,
    invalidate: [qk.alerts.channels],
    onSuccess: () => {
      setUrl("");
      onOpenChange(false);
    },
  });

  const keepingUrl = !!channel && channel.kind === kind && kind !== "email" && url.trim() === "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    let config: Record<string, unknown> = {};
    if (!name.trim()) next.name = "Give the channel a name.";
    if (kind === "email") {
      const r = parseRecipients(recipients);
      if (r.error) next.recipients = r.error;
      config = { to: r.to };
    } else if (!keepingUrl) {
      const err = validateWebhookUrl(kind, url.trim());
      if (err) next.url = err;
      config = { url: url.trim() };
    }
    const parsed = UpsertNotificationChannelRequest.safeParse({ name: name.trim(), kind, enabled, config });
    if (!parsed.success) for (const i of parsed.error.issues) next[String(i.path[0] ?? "form")] ??= i.message;
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;
    save.mutate(parsed.data, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate autoComplete="off">
          <DialogHeader>
            <DialogTitle>{channel ? "Edit notification channel" : "New notification channel"}</DialogTitle>
            <DialogDescription>Where BlockForge sends alert notifications.</DialogDescription>
          </DialogHeader>
          <Field label="Name" error={errors.name} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Ops Discord"
            />
          </Field>
          <Field label="Type" error={errors.kind}>
            <Select
              value={kind}
              onValueChange={setKind}
              options={(Object.keys(KIND_META) as ChannelKind[]).map((k) => ({
                value: k,
                label: KIND_META[k].label,
              }))}
            />
          </Field>
          {kind === "email" ? (
            <Field
              label="Recipients"
              hint="Comma- or newline-separated email addresses."
              error={errors.recipients ?? errors.config}
            >
              <Textarea
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                rows={3}
                spellCheck={false}
              />
            </Field>
          ) : (
            <Field
              label="Webhook URL"
              error={errors.url ?? errors.config}
              hint={
                channel && channel.kind === kind
                  ? "The saved URL is stored encrypted and never shown again. Leave empty to keep it, or enter a new one to replace it."
                  : "Stored encrypted; it is never shown again after saving."
              }
            >
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  channel && channel.kind === kind
                    ? "•••••••• (saved — enter a new URL to replace)"
                    : "https://discord.com/api/webhooks/…"
                }
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
          <label className="flex items-center gap-3">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-sm">Enabled</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {channel ? "Save channel" : "Create channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestButton({ channel }: { channel: Channel }) {
  const test = useApiMutation({
    mutationFn: () => alertsApi.testChannel(channel.id),
    errorTitle: "Test notification failed",
    onSuccess: (r) => {
      if (r.delivered) toast.success(`Test notification delivered to “${channel.name}”`);
      else
        toast.error(`“${channel.name}” did not accept the test notification`, {
          description: r.error ?? undefined,
        });
    },
  });
  return (
    <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
      <Send aria-hidden />
      Send test
    </Button>
  );
}

export function ChannelsTab() {
  const q = useQuery(channelsQuery);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const remove = useApiMutation({
    mutationFn: (id: string) => alertsApi.deleteChannel(id),
    success: "Channel deleted",
    errorTitle: "Could not delete channel",
    invalidate: [qk.alerts.channels, qk.alerts.rules],
    onSuccess: () => setDeleting(null),
  });

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b p-2.5">
        <p className="text-xs text-muted-foreground">
          Webhook URLs are secrets: they are write-only and never displayed after saving.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus aria-hidden />
          New channel
        </Button>
      </div>
      {q.isPending ? (
        <TableSkeleton columns={5} />
      ) : q.isError && !q.data ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load notification channels"
        />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState
          icon={Send}
          title="No notification channels"
          description="Add Discord, a generic webhook or email to be notified when alerts fire."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).map((c) => {
              const Icon = KIND_META[c.kind].icon;
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                      {KIND_META[c.kind].label}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64 text-xs">
                    {c.kind === "email" ? (
                      <span className="break-all">{recipientsOf(c).join(", ") || "—"}</span>
                    ) : (
                      <span className="text-muted-foreground">URL stored (hidden)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={c.enabled ? "success" : "neutral"}>
                      {c.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={c.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <TestButton channel={c} />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${c.name}`}
                        onClick={() => {
                          setEditing(c);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ChannelDialog open={dialogOpen} onOpenChange={setDialogOpen} channel={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete notification channel?"
        description={`“${deleting?.name ?? ""}” will stop receiving notifications and is removed from every alert rule that uses it.`}
        confirmLabel="Delete channel"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
}
