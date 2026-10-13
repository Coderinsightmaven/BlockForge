import { CircleX, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { ExtensionUploadRejectedDetails, MAX_EXTENSION_UPLOAD_BYTES } from "@blockforge/contracts";
import type { ExtensionCompatibility, Server } from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import { describeError, isApiError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/format";
import { isUncertainFailure } from "@/lib/idempotency";
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
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { putToTransferUrl } from "../files/upload";
import { UPLOAD_REJECTION, checkUploadFile, problemsByLevel } from "./extension-model";

interface CompleteOptions {
  replaceExisting: boolean;
  allowIncompatible: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; loaded: number }
  | { kind: "completing"; options: CompleteOptions }
  /**
   * Definitive refusal (422/409 with a reason): nothing was installed and the bytes stay staged
   * under this id, so completion can be tried again with other options.
   */
  | { kind: "rejected"; uploadId: string; reason: string; compatibility: ExtensionCompatibility | null }
  /**
   * The completion's outcome is unknown (network error, 5xx, timeout: the response was lost). The
   * server may have installed the jar with `options` (completion is idempotent per upload id and
   * replays that result), so the only safe step is to retry with exactly the same options.
   */
  | { kind: "uncertain"; uploadId: string; options: CompleteOptions; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "done";
      compatibility: ExtensionCompatibility;
      warnings: Array<{ level: "info" | "warning"; message: string }>;
      restartRequired: boolean;
    };

function Problems({ compatibility }: { compatibility: ExtensionCompatibility | null }) {
  const { errors, warnings } = problemsByLevel(compatibility);
  if (!errors.length && !warnings.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {errors.map((p, i) => (
        <li key={`e${i}`} className="flex items-start gap-1 text-danger">
          <CircleX className="mt-0.5 size-3.5 shrink-0" aria-label="error" />
          <span className="break-words">{p.message}</span>
        </li>
      ))}
      {warnings.map((p, i) => (
        <li key={`w${i}`} className="flex items-start gap-1">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="warning" />
          <span className="break-words">{p.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Upload a plugin/mod jar: announce it (policy + name/size checks), PUT the bytes to the single-use
 * transfer URL (staged outside the install dir), then complete — which validates the jar and moves it
 * into place. A refused completion keeps the staged upload so it can be retried with other options;
 * a completion with an unknown outcome can only be retried with the same options.
 */
export default function UploadDialog({
  server,
  onClose,
  onUploadsDisabled,
  onInstalled,
}: {
  server: Server;
  onClose: () => void;
  onUploadsDisabled: () => void;
  onInstalled: (restartRequired: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [allowIncompatible, setAllowIncompatible] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const busy = phase.kind === "uploading" || phase.kind === "completing";
  // While the outcome of a completion is unknown, the options it was sent with are frozen.
  const frozen =
    phase.kind === "uncertain" ? phase.options : phase.kind === "completing" ? phase.options : null;

  const complete = async (uploadId: string, options: CompleteOptions) => {
    setPhase({ kind: "completing", options });
    try {
      const r = await extensionsApi.completeUpload(server.id, uploadId, options);
      // The installed extension's compatibility includes problems that depend on the other jars (DUPLICATE_ID);
      // a duplicate shown there is not repeated as an upload warning.
      const compatibility = r.extension.compatibility ?? r.compatibility;
      const listedDuplicate = compatibility.problems.some((p) => p.code === "DUPLICATE_ID");
      setPhase({
        kind: "done",
        compatibility,
        warnings: listedDuplicate ? r.warnings.filter((w) => w.code !== "DUPLICATE_ID") : r.warnings,
        restartRequired: r.restartRequired,
      });
      onInstalled(r.restartRequired);
    } catch (err) {
      const details = isApiError(err) ? ExtensionUploadRejectedDetails.safeParse(err.details) : null;
      if (details?.success) {
        setPhase({
          kind: "rejected",
          uploadId,
          reason: details.data.reason,
          compatibility: details.data.compatibility,
        });
      } else if (isUncertainFailure(err)) {
        setPhase({ kind: "uncertain", uploadId, options, message: describeError(err).title });
      } else {
        setPhase({ kind: "error", message: describeError(err).title });
      }
    }
  };

  const start = async () => {
    if (!file) return;
    const problem = checkUploadFile(file);
    if (problem) {
      setFileError(problem);
      return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase({ kind: "uploading", loaded: 0 });
    let uploadId: string;
    try {
      const target = await extensionsApi.startUpload(server.id, {
        filename: file.name,
        sizeBytes: file.size,
      });
      uploadId = target.uploadId;
      await putToTransferUrl(
        target.url,
        file,
        (loaded) => setPhase({ kind: "uploading", loaded }),
        ctrl.signal,
      );
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        setPhase({ kind: "idle" });
        return;
      }
      const details = isApiError(err) ? ExtensionUploadRejectedDetails.safeParse(err.details) : null;
      if (details?.success && details.data.reason === "uploads_disabled") {
        onUploadsDisabled();
        return;
      }
      setPhase({ kind: "error", message: describeError(err).title });
      return;
    }
    await complete(uploadId, { replaceExisting, allowIncompatible });
  };

  const staged = phase.kind === "rejected" || phase.kind === "uncertain";
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        abort.current?.abort();
        onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload a plugin or mod</DialogTitle>
          <DialogDescription>
            A .jar up to {formatBytes(MAX_EXTENSION_UPLOAD_BYTES)}. It is checked before it goes into place
            and takes effect at the next start.
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "done" ? (
          <div className="flex flex-col gap-2">
            <Callout tone="success" title="Installed">
              {phase.restartRequired ? "Restart the server to load it." : "It loads at the next start."}
            </Callout>
            <Problems compatibility={phase.compatibility} />
            {phase.warnings.length ? (
              <ul className="flex flex-col gap-0.5 text-xs">
                {phase.warnings.map((w, i) => (
                  <li key={i} className={w.level === "warning" ? "text-warning" : "text-muted-foreground"}>
                    {w.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="extension-file">Jar file</Label>
              <input
                id="extension-file"
                type="file"
                accept=".jar,application/java-archive"
                disabled={busy || staged}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setFileError(f ? checkUploadFile(f) : null);
                  setPhase({ kind: "idle" });
                }}
                className="text-sm"
              />
              {file ? (
                <span className="text-xs text-muted-foreground">
                  <span className="break-all">{file.name}</span> · {formatBytes(file.size)}
                </span>
              ) : null}
              {fileError ? (
                <p role="alert" className="text-xs text-danger">
                  {fileError}
                </p>
              ) : null}
            </div>
            <div className="flex items-start gap-2">
              <Switch
                id="upload-replace"
                checked={frozen ? frozen.replaceExisting : replaceExisting}
                onCheckedChange={setReplaceExisting}
                disabled={busy || frozen !== null}
              />
              <div>
                <Label htmlFor="upload-replace">Replace the existing file</Label>
                <p className="text-xs text-muted-foreground">
                  If a file with this name exists; the old one is kept for rollback.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Switch
                id="upload-incompatible"
                checked={frozen ? frozen.allowIncompatible : allowIncompatible}
                onCheckedChange={setAllowIncompatible}
                disabled={busy || frozen !== null}
              />
              <div>
                <Label htmlFor="upload-incompatible">Install although incompatible</Label>
                <p className="text-xs text-muted-foreground">
                  Only for jars this server software reports it won't load. They usually fail at start.
                </p>
              </div>
            </div>
            {phase.kind === "uploading" && file ? (
              <Progress value={(phase.loaded / file.size) * 100} label={`Uploading ${file.name}`} />
            ) : null}
            {phase.kind === "completing" ? (
              <p className="text-xs text-muted-foreground">Checking the jar…</p>
            ) : null}
            {phase.kind === "rejected" ? (
              <div role="alert" className="flex flex-col gap-1.5">
                <Callout tone="danger" title="Not installed">
                  {UPLOAD_REJECTION[phase.reason] ?? phase.reason}
                </Callout>
                <Problems compatibility={phase.compatibility} />
              </div>
            ) : null}
            {phase.kind === "uncertain" ? (
              <div role="alert" className="flex flex-col gap-1 text-sm">
                <p className="text-danger">{phase.message}</p>
                <p className="text-xs text-muted-foreground">
                  It is unknown whether the jar was installed. Retry checks again with the same options; if it
                  was installed, that result is shown.
                </p>
              </div>
            ) : null}
            {phase.kind === "error" ? (
              <p role="alert" className="text-sm text-danger">
                {phase.message}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              abort.current?.abort();
              onClose();
            }}
          >
            {phase.kind === "done" ? "Close" : "Cancel"}
          </Button>
          {phase.kind === "done" ? null : phase.kind === "uncertain" ? (
            <Button onClick={() => void complete(phase.uploadId, phase.options)}>Retry</Button>
          ) : phase.kind === "rejected" ? (
            <Button onClick={() => void complete(phase.uploadId, { replaceExisting, allowIncompatible })}>
              Try again with these options
            </Button>
          ) : phase.kind === "completing" ? (
            <Button loading>Checking…</Button>
          ) : (
            <Button loading={busy} disabled={!file || fileError !== null} onClick={() => void start()}>
              Upload
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
