import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileWarning } from "lucide-react";
import { useEffect, useState } from "react";
import { canStartOperation } from "@blockforge/contracts";
import type { Server } from "@blockforge/contracts";
import { newIdempotencyKey } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { filesApi, serversApi } from "@/lib/api/servers-api";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EULA_FILE, EULA_URL, acceptEulaContent, eulaAccepted } from "./eula";

/** "accepted" | "needed" | "unknown" (no file / no read access / not loaded). */
export type EulaFileState = "accepted" | "needed" | "unknown";

/**
 * Whether to offer EULA acceptance: the file says it is not accepted, or the console printed the
 * refusal and the file does not say it was accepted since.
 */
export function shouldShowEulaBanner(fileState: EulaFileState, promptSeen: boolean): boolean {
  return fileState === "needed" || (promptSeen && fileState !== "accepted");
}

/** Which power action brings the server up after accepting (Pterodactyl restarts it). */
export function eulaFollowUpAction(
  server: Pick<Server, "state" | "activeOperation">,
): "start" | "restart" | null {
  if (canStartOperation("start", server.state, server.activeOperation)) return "start";
  if (canStartOperation("restart", server.state, server.activeOperation)) return "restart";
  return null;
}

/**
 * Write `eula=true` with an optimistic-concurrency check (one retry if the file changed between
 * read and write), then start the server. Exported for tests.
 */
export async function acceptEula(
  server: Pick<Server, "id" | "state" | "activeOperation">,
): Promise<{ started: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string | null = null;
    let sha: string | null = null;
    try {
      const current = await filesApi.contents(server.id, EULA_FILE);
      content = current.encoding === "utf8" ? current.content : null;
      sha = current.sha256;
    } catch (err) {
      if (!(isApiError(err) && err.code === "NOT_FOUND")) throw err;
    }
    if (content !== null && eulaAccepted(content)) break;
    try {
      await filesApi.write(server.id, {
        path: EULA_FILE,
        content: acceptEulaContent(content),
        baseSha256: sha,
      });
      break;
    } catch (err) {
      const conflict = isApiError(err) && (err.code === "CONFLICT" || err.code === "PRECONDITION_FAILED");
      if (!conflict || attempt === 1) throw err;
    }
  }
  const action = eulaFollowUpAction(server);
  if (!action) return { started: false };
  await serversApi.action(server.id, { action }, newIdempotencyKey());
  return { started: true };
}

export function EulaBanner({
  server,
  promptSeen,
  onAccepted,
}: {
  server: Server;
  promptSeen: boolean;
  onAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const isMinecraft = server.game === "minecraft-java";
  const canRead = serverCan(server, "servers.files.read");
  const file = useQuery({
    queryKey: qk.server(server.id).file(EULA_FILE),
    queryFn: ({ signal }) => filesApi.contents(server.id, EULA_FILE, signal),
    enabled: isMinecraft && canRead && server.state !== "provisioning",
    retry: false,
    staleTime: 30_000,
  });
  // The server writes/refuses on start: re-check whenever it stops or crashes.
  useEffect(() => {
    if (server.state === "stopped" || server.state === "crashed") {
      void queryClient.invalidateQueries({ queryKey: qk.server(server.id).file(EULA_FILE) });
    }
  }, [server.state, server.id, queryClient]);

  const fileState: EulaFileState =
    file.data && file.data.encoding === "utf8"
      ? eulaAccepted(file.data.content)
        ? "accepted"
        : "needed"
      : "unknown";
  const canAccept =
    serverActionable(server, "servers.files.write") && serverActionable(server, "servers.control");

  const accept = useApiMutation({
    mutationFn: () => acceptEula(server),
    success: (r) =>
      r.started
        ? "EULA accepted — starting the server"
        : "EULA accepted — start the server when it has stopped",
    errorTitle: "Could not accept the EULA",
    onSuccess: async () => {
      setOpen(false);
      onAccepted();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.server(server.id).file(EULA_FILE) }),
        queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) }),
      ]);
    },
  });

  if (!isMinecraft || !shouldShowEulaBanner(fileState, promptSeen)) return null;
  return (
    <>
      <Callout
        tone="warning"
        title="Accept the Minecraft EULA"
        action={
          canAccept ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <FileWarning aria-hidden />
              Review & accept
            </Button>
          ) : undefined
        }
      >
        Minecraft will not start until its End User License Agreement is accepted in{" "}
        <code className="font-mono">eula.txt</code>.
        {canAccept ? null : " Ask the server's owner to accept it (needs file write and power access)."}
      </Callout>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Accept the Minecraft EULA?"
        description={
          <span className="flex flex-col gap-2">
            <span>
              By accepting you agree to Mojang's{" "}
              <a
                href={EULA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Minecraft End User License Agreement <ExternalLink className="size-3" aria-hidden />
              </a>
              . BlockForge writes <code className="font-mono">eula=true</code> to eula.txt and starts the
              server.
            </span>
          </span>
        }
        confirmLabel="I accept"
        pending={accept.isPending}
        onConfirm={() => accept.mutate()}
      />
    </>
  );
}
