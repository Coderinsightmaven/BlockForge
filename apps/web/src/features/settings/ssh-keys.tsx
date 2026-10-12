import { useQuery } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import type { SshKey } from "@blockforge/contracts";
import { accountApi } from "@/lib/api/servers-api";
import { describeError } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { sshKeysQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
];

/**
 * Quick client check of an OpenSSH public key line ("type base64 [comment]"). The control plane
 * parses it properly (and refuses RSA < 3072 bits); this only catches obvious paste mistakes.
 */
export function checkPublicKey(text: string): { error: string | null; comment: string | null } {
  const line = text.trim();
  if (!line) return { error: "Paste a public key.", comment: null };
  if (/PRIVATE KEY/.test(line))
    return {
      error: "That is a private key. Paste the .pub file contents instead — never share the private key.",
      comment: null,
    };
  if (/\r|\n/.test(line))
    return { error: "Paste a single line (the contents of your .pub file).", comment: null };
  const [type, data, ...rest] = line.split(/\s+/);
  if (!type || !KEY_TYPES.includes(type))
    return { error: `Unsupported key type. Use one of: ${KEY_TYPES.join(", ")}.`, comment: null };
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length < 32)
    return { error: "The key data does not look like base64.", comment: null };
  return { error: null, comment: rest.join(" ") || null };
}

function AddKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useApiMutation({
    mutationFn: (body: { name: string; publicKey: string }) => accountApi.addSshKey(body),
    success: "SSH key added",
    errorTitle: "Could not add the key",
    silentError: true,
    onError: (e) => setErrors({ publicKey: describeError(e).title }),
    invalidate: [qk.account.sshKeys],
    onSuccess: () => {
      setName("");
      setKey("");
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const check = checkPublicKey(key);
    if (check.error) next.publicKey = check.error;
    const label = name.trim() || check.comment || "";
    if (!label) next.name = "Name the key (e.g. the computer it is on).";
    setErrors(next);
    if (Object.keys(next).length) return;
    add.mutate({ name: label.slice(0, 80), publicKey: key.trim() });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add an SSH key</DialogTitle>
            <DialogDescription>
              Used for SFTP to servers you can access. ed25519 is recommended; RSA keys need at least 3072
              bits.
            </DialogDescription>
          </DialogHeader>
          <Field label="Public key" error={errors.publicKey} hint="Contents of e.g. ~/.ssh/id_ed25519.pub">
            <Textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={4}
              className="font-mono text-xs break-all"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <Field label="Name" error={errors.name} hint="Defaults to the key's comment.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={add.isPending}>
              Add key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SshKeysCard({ mfaEnabled }: { mfaEnabled: boolean }) {
  const q = useQuery(sshKeysQuery);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SshKey | null>(null);
  const remove = useApiMutation({
    mutationFn: (k: SshKey) => accountApi.removeSshKey(k.id),
    success: "SSH key removed",
    errorTitle: "Could not remove the key",
    invalidate: [qk.account.sshKeys],
    onSuccess: () => setRemoving(null),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>SSH keys</CardTitle>
          <CardDescription>Log in to SFTP without a password.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add key
        </Button>
      </CardHeader>
      {mfaEnabled ? (
        <Callout tone="info" className="mx-4 mb-3">
          Your account uses two-factor authentication, so SFTP password login is refused — use an SSH key.
        </Callout>
      ) : null}
      {q.isPending ? (
        <TableSkeleton columns={4} rows={2} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load SSH keys"
          compact
        />
      ) : q.data.length === 0 ? (
        <EmptyState icon={KeyRound} title="No SSH keys" compact />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Fingerprint</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <div className="font-medium">{k.name}</div>
                  <div className="text-xs text-muted-foreground">{k.keyType}</div>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <code className="font-mono text-xs break-all">{k.fingerprint}</code>
                    <CopyButton value={k.fingerprint} label="Copy fingerprint" className="size-6" />
                  </span>
                </TableCell>
                <TableCell className="text-xs">
                  <Timestamp ts={k.createdAt} />
                </TableCell>
                <TableCell className="text-xs">
                  {k.lastUsedAt ? <Timestamp ts={k.lastUsedAt} /> : "Never"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${k.name}`}
                    onClick={() => setRemoving(k)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AddKeyDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove SSH key?"
        description={`“${removing?.name ?? ""}” can no longer be used for SFTP.`}
        confirmLabel="Remove key"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
