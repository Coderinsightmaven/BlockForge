import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { PlayerActionRequest, PlayerName } from "@blockforge/contracts";
import type { PlayerLookupResponse, Server } from "@blockforge/contracts";
import { playersApi } from "@/lib/api/players-api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
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
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ACTION_TITLE, NEEDS_LOOKUP, describePlayerActionError, stoppedOnlyReason } from "./player-model";
import type { DialogAction } from "./player-model";

/* The player action dialog (kick, ban, IP ban, op, whitelist): its own chunk. */

function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export default function ActionDialog({
  server,
  action,
  presetName,
  presetUuid = null,
  onClose,
  onSubmit,
  pending,
}: {
  server: Server;
  action: DialogAction;
  presetName: string | null;
  /** The online player's UUID when known (compared with the lookup). */
  presetUuid?: string | null;
  onClose: () => void;
  onSubmit: (body: PlayerActionRequest) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(presetName ?? "");
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const [level, setLevel] = useState("4");
  const [bypass, setBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The lookup result and the exact name it was made for: adding is enabled only while the field
  // still holds exactly that name (any edit needs a new lookup).
  const [lookup, setLookup] = useState<{ for: string; result: PlayerLookupResponse } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const stoppedReason = stoppedOnlyReason(server);
  const needsLookup = NEEDS_LOOKUP.has(action);
  const lookedUp = lookup !== null && lookup.for === name.trim() ? lookup.result : null;
  const requestSeq = useRef(0);

  const doLookup = async (raw: string) => {
    const n = PlayerName.safeParse(raw.trim());
    if (!n.success) {
      setLookupError("1–16 letters, digits or underscores.");
      return;
    }
    const seq = ++requestSeq.current;
    setLooking(true);
    setLookupError(null);
    try {
      const result = await playersApi.lookup(server.id, n.data);
      if (seq === requestSeq.current) setLookup({ for: n.data, result });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLookup(null);
      setLookupError(describePlayerActionError(err).title);
    } finally {
      if (seq === requestSeq.current) setLooking(false);
    }
  };
  // A quick action (name taken from the online list) looks the name up right away.
  useEffect(() => {
    if (needsLookup && presetName !== null) void doLookup(presetName);
    // Once, for the preset name.
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (needsLookup && !lookedUp) return;
    const expiresAt = localInputToEpoch(expires);
    if (expires && (expiresAt === null || expiresAt <= Date.now())) {
      setError("Choose an expiry in the future.");
      return;
    }
    const trimmedReason = reason.trim() || undefined;
    const raw =
      action === "kick"
        ? { action, name: name.trim(), reason: trimmedReason }
        : action === "ban"
          ? { action, name: name.trim(), reason: trimmedReason, ...(expiresAt ? { expiresAt } : {}) }
          : action === "ban-ip"
            ? { action, ip: ip.trim(), reason: trimmedReason, ...(expiresAt ? { expiresAt } : {}) }
            : action === "op"
              ? {
                  action,
                  name: name.trim(),
                  ...(stoppedReason ? {} : { level: Number(level), bypassesPlayerLimit: bypass }),
                }
              : { action, name: name.trim() };
    const parsed = PlayerActionRequest.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    setError(null);
    onSubmit(parsed.data);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{ACTION_TITLE[action]}</DialogTitle>
            <DialogDescription>
              {stoppedReason
                ? "The server is running: this is sent as a console command and the server's reply is shown."
                : "The server is stopped: the list file is edited directly."}
            </DialogDescription>
          </DialogHeader>
          {action === "ban-ip" ? (
            <Field label="IPv4 address" hint="IP bans only match IPv4 addresses, like 203.0.113.7.">
              <Input value={ip} onChange={(e) => setIp(e.target.value)} autoFocus spellCheck={false} />
            </Field>
          ) : (
            <div className="flex items-end gap-2">
              <Field label="Player name" className="flex-1">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setLookup(null);
                    setLookupError(null);
                  }}
                  readOnly={presetName !== null}
                  maxLength={16}
                  autoFocus={presetName === null}
                  spellCheck={false}
                />
              </Field>
              {needsLookup ? (
                <Button variant="outline" loading={looking} onClick={() => void doLookup(name)}>
                  {lookedUp ? "Look up again" : "Look up"}
                </Button>
              ) : null}
            </div>
          )}
          {needsLookup && lookedUp ? (
            <p className="text-xs" role="status">
              <span className="font-medium">{lookedUp.name}</span> ·{" "}
              <code className="font-mono">{lookedUp.uuid}</code> ·{" "}
              {lookedUp.source === "mojang"
                ? "Mojang account"
                : "offline-mode UUID (the server is not in online mode)"}
            </p>
          ) : needsLookup && looking ? (
            <p className="text-xs text-muted-foreground" role="status">
              Looking up {name.trim()}…
            </p>
          ) : needsLookup && !lookupError ? (
            <p className="text-xs text-muted-foreground">
              Look the name up first: the account it resolves to (UUID and source) is shown before anything is
              added.
            </p>
          ) : null}
          {needsLookup &&
          lookedUp &&
          presetUuid &&
          presetUuid.toLowerCase() !== lookedUp.uuid.toLowerCase() ? (
            <p role="alert" className="text-xs text-warning">
              This name resolves to a different UUID than the online player ({presetUuid}). Check that it is
              the account you mean.
            </p>
          ) : null}
          {lookupError ? (
            <p role="alert" className="text-xs text-danger">
              {lookupError}
            </p>
          ) : null}
          {action === "kick" || action === "ban" || action === "ban-ip" ? (
            <Field label="Reason" hint="Optional, one line, at most 200 characters.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            </Field>
          ) : null}
          {action === "ban" || action === "ban-ip" ? (
            <Field label="Expires" hint={stoppedReason ?? "Empty = permanent."}>
              <Input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                disabled={stoppedReason !== null}
              />
            </Field>
          ) : null}
          {action === "op" ? (
            <div className="flex flex-col gap-2">
              <Field
                label="Operator level"
                hint={stoppedReason ?? "4 = every command; lower levels limit commands."}
              >
                <Select
                  value={level}
                  onValueChange={setLevel}
                  disabled={stoppedReason !== null}
                  options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Switch
                  id="op-bypass"
                  checked={bypass}
                  onCheckedChange={setBypass}
                  disabled={stoppedReason !== null}
                />
                <Label htmlFor="op-bypass">May join when the server is full</Label>
              </div>
              <Callout tone="warning">
                Operators can run any in-game command, including /op for others.
              </Callout>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={needsLookup && !lookedUp}>
              {action === "kick"
                ? "Kick"
                : action === "op"
                  ? "Make operator"
                  : action === "whitelist-add"
                    ? "Add"
                    : "Ban"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
