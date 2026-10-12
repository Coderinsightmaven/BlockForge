import { useNavigate } from "@tanstack/react-router";
import { BellPlus, Gamepad2, Plus, ServerCog, UserPlus } from "lucide-react";
import type { Me } from "@blockforge/contracts";
import { canAny, hasGlobal } from "@/lib/permissions";
import { useEnrollmentDialog } from "@/features/nodes/enrollment-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface QuickAction {
  id: string;
  label: string;
  run: () => void;
  icon: typeof Plus;
}

/** Actions the signed-in user can actually perform (no placeholders). */
export function useQuickActions(me: Me | undefined): QuickAction[] {
  const navigate = useNavigate();
  const enrollment = useEnrollmentDialog();
  const actions: QuickAction[] = [];
  if (canAny(me, "servers.create"))
    actions.push({
      id: "server",
      label: "Create server",
      icon: Gamepad2,
      run: () => void navigate({ to: "/servers/new" }),
    });
  if (hasGlobal(me, "nodes.enroll"))
    actions.push({ id: "enroll", label: "Enroll node", icon: ServerCog, run: enrollment.open });
  if (canAny(me, "alerts.manage"))
    actions.push({
      id: "alert-rule",
      label: "New alert rule",
      icon: BellPlus,
      run: () => void navigate({ to: "/alerts", search: { tab: "rules", create: true } }),
    });
  if (hasGlobal(me, "users.manage"))
    actions.push({
      id: "user",
      label: "Create user",
      icon: UserPlus,
      run: () => void navigate({ to: "/users", search: { create: true } }),
    });
  return actions;
}

export function QuickActionsMenu({ me }: { me: Me | undefined }) {
  const actions = useQuickActions(me);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Quick actions">
          <Plus aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
        {actions.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={a.run}>
            <a.icon aria-hidden />
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
