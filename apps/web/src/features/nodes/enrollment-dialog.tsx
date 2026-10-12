import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { CreateEnrollmentTokenRequest } from "@blockforge/contracts";
import type { z } from "zod";
import { nodesApi } from "@/lib/api/endpoints";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { formatTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
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
import { parseTags } from "./node-utils";

type Created = Awaited<ReturnType<typeof nodesApi.createEnrollmentToken>>;

const EXPIRY_OPTIONS = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "360", label: "6 hours" },
  { value: "1440", label: "24 hours" },
  { value: "10080", label: "7 days" },
] as const;
type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

interface EnrollmentContextValue {
  open: () => void;
}
const EnrollmentContext = createContext<EnrollmentContextValue | null>(null);

/** Hosts the single enrollment dialog so the header quick action and pages can open it. */
export function EnrollmentDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <EnrollmentContext.Provider value={value}>
      {children}
      <EnrollmentDialog open={isOpen} onOpenChange={setOpen} />
    </EnrollmentContext.Provider>
  );
}

export function useEnrollmentDialog(): EnrollmentContextValue {
  const ctx = useContext(EnrollmentContext);
  if (!ctx) throw new Error("useEnrollmentDialog must be used inside EnrollmentDialogProvider");
  return ctx;
}

function EnrollmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [created, setCreated] = useState<Created | null>(null);
  const close = () => {
    onOpenChange(false);
    setCreated(null);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        className="max-w-xl"
        // Once the secret is on screen, closing must be a deliberate click on "Done".
        onEscapeKeyDown={(e) => created && e.preventDefault()}
        onInteractOutside={(e) => created && e.preventDefault()}
        hideClose={!!created}
      >
        {created ? (
          <TokenResult created={created} onDone={close} />
        ) : (
          <TokenForm onCreated={setCreated} onCancel={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TokenForm({ onCreated, onCancel }: { onCreated: (c: Created) => void; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryValue>("60");
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [location, setLocation] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useApiMutation({
    mutationFn: (body: z.input<typeof CreateEnrollmentTokenRequest>) => nodesApi.createEnrollmentToken(body),
    errorTitle: "Could not create enrollment token",
    // The response holds the one-time secret: it lives only in this dialog's state.
    sensitive: true,
    invalidate: [qk.nodes.tokens],
    onSuccess: (data) => onCreated(data),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const tags = parseTags(tagsText);
    const next: Record<string, string> = {};
    if (tags.error) next.tags = tags.error;
    const parsed = CreateEnrollmentTokenRequest.safeParse({
      label,
      expiresInMinutes: Number(expiry),
      requiresApproval,
      location: location.trim() || null,
      tags: tags.tags,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
    }
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;
    create.mutate(parsed.data);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Enroll a node</DialogTitle>
        <DialogDescription>
          Create a one-time enrollment token, then run the install command on the machine. The agent generates
          its own key pair; the token only authorises the first connection.
        </DialogDescription>
      </DialogHeader>
      <Field
        label="Label"
        hint="Shown in the token list, e.g. the machine you are enrolling."
        error={errors.label}
        required
      >
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          autoFocus
          placeholder="fra-node-03"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Token expires after" error={errors.expiresInMinutes}>
          <Select
            value={expiry}
            onValueChange={setExpiry}
            options={EXPIRY_OPTIONS}
            aria-label="Token expiry"
          />
        </Field>
        <Field label="Location" hint="Optional; copied to the node." error={errors.location}>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={80}
            placeholder="Frankfurt"
          />
        </Field>
      </div>
      <Field
        label="Tags"
        hint="Optional, comma-separated; copied to the node and usable for placement."
        error={errors.tags}
      >
        <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="eu, ssd" />
      </Field>
      <label className="flex items-start gap-3 rounded-md border p-3">
        <Switch
          checked={requiresApproval}
          onCheckedChange={setRequiresApproval}
          aria-describedby="approval-hint"
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Require administrator approval</span>
          <span id="approval-hint" className="text-xs text-muted-foreground">
            The node connects but receives no workloads until someone approves it on its detail page.
            Recommended when the token may be seen by others.
          </span>
        </span>
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending}>
          Create token
        </Button>
      </DialogFooter>
    </form>
  );
}

function TokenResult({ created, onDone }: { created: Created; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Enrollment token created</DialogTitle>
        <DialogDescription>
          “{created.token.label}” · expires {formatTimestamp(created.token.expiresAt)}
          {created.token.requiresApproval ? " · requires approval after enrollment" : ""}
        </DialogDescription>
      </DialogHeader>
      <Callout tone="warning" title="Copy it now — it is shown only once" role="alert">
        The secret cannot be retrieved again. If you lose it, revoke this token and create a new one. Treat it
        like a password until it is used or expires.
      </Callout>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Install command (run as root on the node)</span>
        <div className="flex items-start gap-2">
          <pre className="max-h-40 min-w-0 flex-1 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
            {created.installCommand}
          </pre>
          <CopyButton value={created.installCommand} label="Copy install command" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Token</span>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={created.secretToken}
            className="font-mono text-xs"
            aria-label="Enrollment token"
            onFocus={(e) => e.currentTarget.select()}
          />
          <CopyButton value={created.secretToken} label="Copy token" />
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        The node appears in the Nodes list after the agent connects
        {created.token.requiresApproval ? " and waits for approval" : ""}.
      </p>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}
