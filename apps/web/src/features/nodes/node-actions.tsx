import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BadgeCheck, ChevronDown, KeyRound, ShieldOff, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Node } from "@blockforge/contracts";
import { nodesApi } from "@/lib/api/endpoints";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { upsertNodeInCache } from "@/lib/realtime/handlers";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Action = "approve" | "rotate" | "revoke" | "delete";

export function useApproveNode(node: Node) {
  const queryClient = useQueryClient();
  return useApiMutation({
    mutationFn: () => nodesApi.approve(node.id),
    success: `${node.name} approved`,
    errorTitle: "Could not approve node",
    invalidate: [qk.overview],
    onSuccess: (n) => upsertNodeInCache(queryClient, n),
  });
}

export function NodeActions({ node }: { node: Node }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Action | null>(null);
  const close = () => setOpen(null);
  const onNode = (n: Node) => {
    upsertNodeInCache(queryClient, n);
    close();
  };

  const approve = useApproveNode(node);
  const rotate = useApiMutation({
    mutationFn: () => nodesApi.rotateCredentials(node.id),
    success: "Credential rotation started",
    errorTitle: "Could not rotate credentials",
    onSuccess: onNode,
  });
  const revoke = useApiMutation({
    mutationFn: () => nodesApi.revoke(node.id),
    success: `${node.name} revoked`,
    errorTitle: "Could not revoke node",
    invalidate: [qk.overview],
    onSuccess: onNode,
  });
  const remove = useApiMutation({
    mutationFn: () => nodesApi.remove(node.id),
    success: `${node.name} deleted`,
    errorTitle: "Could not delete node",
    onSuccess: async () => {
      close();
      queryClient.removeQueries({ queryKey: qk.nodes.detail(node.id) });
      await queryClient.invalidateQueries({ queryKey: qk.nodes.all });
      await queryClient.invalidateQueries({ queryKey: qk.overview });
      await navigate({ to: "/nodes" });
    },
  });

  const revoked = node.status === "revoked";
  const hasServers = node.serverCount > 0;

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            Actions
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {node.status === "pending" ? (
            <DropdownMenuItem onSelect={() => setOpen("approve")}>
              <BadgeCheck aria-hidden />
              Approve node
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={revoked || node.connection === "offline"}
            onSelect={() => setOpen("rotate")}
          >
            <KeyRound aria-hidden />
            Rotate credentials
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={revoked} onSelect={() => setOpen("revoke")}>
            <ShieldOff aria-hidden />
            Revoke node
          </DropdownMenuItem>
          <DropdownMenuItem destructive disabled={hasServers} onSelect={() => setOpen("delete")}>
            <Trash2 aria-hidden />
            {hasServers
              ? `Delete (hosts ${node.serverCount} server${node.serverCount === 1 ? "" : "s"})`
              : "Delete node"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={open === "approve"}
        onOpenChange={(o) => !o && close()}
        title={`Approve ${node.name}?`}
        description="The node becomes active and eligible for workloads. Approve only machines you enrolled yourself and recognise."
        confirmLabel="Approve"
        pending={approve.isPending}
        onConfirm={() => approve.mutate(undefined, { onSuccess: close })}
      />
      <ConfirmDialog
        open={open === "rotate"}
        onOpenChange={(o) => !o && close()}
        title="Rotate agent credentials?"
        description="The agent generates a new key pair and the control plane switches to it; the old key stops being accepted once the rotation completes. The node must be connected."
        confirmLabel="Rotate credentials"
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
      <ConfirmDialog
        open={open === "revoke"}
        onOpenChange={(o) => !o && close()}
        title={`Revoke ${node.name}?`}
        description={
          <>
            The agent session is closed immediately and its key is revoked, so it can no longer connect or
            receive commands. Workloads already running on the machine are not stopped but can no longer be
            managed. Re-adding the machine requires a new enrollment token.{" "}
            <strong className="text-foreground">This cannot be undone.</strong>
          </>
        }
        confirmLabel="Revoke node"
        destructive
        confirmText={node.name}
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
      <ConfirmDialog
        open={open === "delete"}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${node.name}?`}
        description="Removes the node and its history from BlockForge. Only possible when it hosts no servers. Metrics already stored expire with retention."
        confirmLabel="Delete node"
        destructive
        confirmText={node.name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
