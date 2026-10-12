import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, PlugZap } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { BackupStorageSettings } from "@blockforge/contracts";
import type { BackupStorageSettingsView } from "@blockforge/contracts";
import type { z } from "zod";
import { backupStorageApi } from "@/lib/api/phase4-api";
import type { BackupStorageTestResult } from "@/lib/api/phase4-api";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { useSyncedForm } from "@/lib/use-synced-form";
import { ChangedElsewhere } from "@/components/common/changed-elsewhere";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export interface StorageForm {
  type: "local" | "s3";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  /** Write-only: blank keeps the stored secret. */
  secretAccessKey: string;
}

export type StorageView = z.infer<typeof BackupStorageSettingsView>;

const EMPTY_FORM: StorageForm = {
  type: "local",
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "blockforge/",
  forcePathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

/** Form state from the secret-free read shape; the secret field always starts empty. */
export function formFromView(view: StorageView | undefined): StorageForm {
  const v = view?.value;
  if (!v || v.type === "local") return { ...EMPTY_FORM };
  return { ...EMPTY_FORM, ...v, type: "s3", secretAccessKey: "" };
}

/**
 * Validate the form into a `BackupStorageSettings` value. The secret is sent only when typed, and
 * must be typed whenever S3 is selected but no secret is stored yet (`secretAccessKeySet` false —
 * also right after switching from local).
 */
export function storageRequest(
  form: StorageForm,
  secretAccessKeySet: boolean,
): { body: BackupStorageSettings | null; errors: Record<string, string> } {
  if (form.type === "local") return { body: { type: "local" }, errors: {} };
  const errors: Record<string, string> = {};
  const secret = form.secretAccessKey.trim();
  if (!secret && !secretAccessKeySet) errors.secretAccessKey = "Enter the secret access key.";
  const parsed = BackupStorageSettings.safeParse({
    type: "s3",
    endpoint: form.endpoint.trim(),
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    prefix: form.prefix.trim(),
    forcePathStyle: form.forcePathStyle,
    accessKeyId: form.accessKeyId.trim(),
    ...(secret ? { secretAccessKey: secret } : {}),
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = String(i.path[0]);
      errors[key] ??=
        key === "endpoint"
          ? "An https:// URL, e.g. https://s3.eu-central-1.amazonaws.com"
          : key === "bucket"
            ? "3–63 characters."
            : i.message;
    }
  }
  return { body: parsed.success && Object.keys(errors).length === 0 ? parsed.data : null, errors };
}

const withoutSecret = (f: StorageForm) => ({ ...f, secretAccessKey: "" });

export default function BackupStorageCard() {
  const queryClient = useQueryClient();
  // The view keeps `secretAccessKeySet` next to the secret-free value (strict schema: a response
  // that carried the secret would be rejected, so it can never land in the cache).
  const q = useQuery({
    queryKey: qk.settings.backupStorage,
    queryFn: ({ signal }) => backupStorageApi.view(signal),
  });
  // Refetches (focus, reconnect, another admin's save) only update the form while it has no unsaved
  // edits; otherwise "changed elsewhere" is shown.
  const synced = useSyncedForm(q.data, formFromView);
  const form = synced.form ?? formFromView(undefined);
  const setForm = synced.setForm;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<BackupStorageTestResult | null>(null);
  const secretSet = q.data?.secretAccessKeySet ?? false;
  const dirty = synced.dirty;
  const valid = storageRequest(form, secretSet).body !== null;
  const save = useApiMutation({
    mutationFn: (body: BackupStorageSettings) => backupStorageApi.put(body),
    success: "Backup storage saved",
    errorTitle: "Could not save backup storage",
    // The request may carry the S3 secret.
    sensitive: true,
    onError: (err) => setErrors(fieldErrorsFrom(err)),
    onSuccess: async (view) => {
      // Drop the typed secret first; the stored one is only ever reported as a flag.
      setForm(withoutSecret);
      setResult(null);
      if (view) {
        queryClient.setQueryData(qk.settings.backupStorage, view);
        synced.reset(view);
      }
      await queryClient.invalidateQueries({ queryKey: qk.settings.backupStorage });
    },
  });
  const test = useApiMutation({
    // Tests the values as typed (unsaved credentials included); a blank secret uses the stored one.
    mutationFn: (value: BackupStorageSettings) => backupStorageApi.test(value),
    errorTitle: "Could not run the connection test",
    sensitive: true,
    onSuccess: (r) => setResult(r),
  });
  const set = <K extends keyof StorageForm>(k: K, v: StorageForm[K]) => {
    // Switching to local storage discards a typed secret.
    setForm((f) =>
      k === "type" && v === "local" ? { ...withoutSecret(f), type: "local" } : { ...f, [k]: v },
    );
    setResult(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { body, errors: next } = storageRequest(form, secretSet);
    setErrors(next);
    if (body) save.mutate(body);
  };
  const runTest = () => {
    const { body, errors: next } = storageRequest(form, secretSet);
    setErrors(next);
    if (body) test.mutate(body);
  };
  if (q.isPending)
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  if (q.isError)
    return (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load backup storage" />
    );
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Backup storage</CardTitle>
          <CardDescription>
            Where completed backups are kept. Applies to new backups; existing ones stay where they are.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" noValidate>
          {synced.changedElsewhere ? <ChangedElsewhere onDiscard={() => synced.reset()} /> : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Storage</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="storage-type"
                checked={form.type === "local"}
                onChange={() => set("type", "local")}
                className="mt-1"
              />
              <span>
                On the node
                <span className="block text-xs text-muted-foreground">
                  Archives stay on the server's node disk. Lost with the node.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="storage-type"
                checked={form.type === "s3"}
                onChange={() => set("type", "s3")}
                className="mt-1"
              />
              <span>
                S3-compatible object storage
                <span className="block text-xs text-muted-foreground">
                  Nodes upload through short-lived presigned URLs; the credentials never leave the control
                  plane.
                </span>
              </span>
            </label>
          </fieldset>
          {form.type === "s3" ? (
            <>
              <Field label="Endpoint" error={errors.endpoint} required hint="HTTPS only.">
                <Input
                  value={form.endpoint}
                  onChange={(e) => set("endpoint", e.target.value)}
                  placeholder="https://s3.eu-central-1.amazonaws.com"
                  spellCheck={false}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Region" error={errors.region} required>
                  <Input
                    value={form.region}
                    onChange={(e) => set("region", e.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <Field label="Bucket" error={errors.bucket} required>
                  <Input
                    value={form.bucket}
                    onChange={(e) => set("bucket", e.target.value)}
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Key prefix" error={errors.prefix} hint="Objects are stored below this prefix.">
                <Input
                  value={form.prefix}
                  onChange={(e) => set("prefix", e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <div className="flex items-start gap-3">
                <Switch
                  id="storage-path-style"
                  checked={form.forcePathStyle}
                  onCheckedChange={(v) => set("forcePathStyle", v)}
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="storage-path-style">Path-style addressing</Label>
                  <p className="text-xs text-muted-foreground">
                    endpoint/bucket/key instead of bucket.endpoint/key — needed by MinIO and some providers.
                  </p>
                </div>
              </div>
              <Field label="Access key ID" error={errors.accessKeyId} required>
                <Input
                  value={form.accessKeyId}
                  onChange={(e) => set("accessKeyId", e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Secret access key"
                error={errors.secretAccessKey}
                required={!secretSet}
                hint={
                  secretSet
                    ? "A secret is stored. Leave blank to keep it; it is never shown again."
                    : "Stored encrypted; never shown again."
                }
              >
                <Input
                  type="password"
                  value={form.secretAccessKey}
                  onChange={(e) => set("secretAccessKey", e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </Field>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
            {form.type === "s3" ? (
              <Button
                variant="outline"
                loading={test.isPending}
                disabled={!valid}
                title={valid ? undefined : "Fill in the S3 settings first."}
                onClick={runTest}
              >
                <PlugZap aria-hidden />
                Test connection
              </Button>
            ) : null}
            {form.type === "s3" && dirty ? (
              <span className="text-xs text-muted-foreground">Tests the values above, before saving.</span>
            ) : null}
          </div>
          {result ? (
            result.ok ? (
              <Callout tone="success" title="Connection works" role="status">
                <span className="inline-flex items-center gap-1">
                  <CircleCheck className="size-3.5" aria-hidden />
                  The bucket is reachable and a probe object was written and deleted.
                </span>
              </Callout>
            ) : (
              <Callout tone="danger" title="Connection failed" role="alert">
                {result.error ?? "The storage did not accept the probe."}
              </Callout>
            )
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
