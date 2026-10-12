import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  CreateUserRequest,
  PERMISSIONS,
  PRIVILEGED_ROLES,
  Password,
  UpdateUserRequest,
  permissionAllowsScope,
} from "@blockforge/contracts";
import type { Me, Role, RoleBinding, ScopeType, User } from "@blockforge/contracts";
import type { z } from "zod";
import { usersApi } from "@/lib/api/endpoints";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/mutations";
import { isOwner } from "@/lib/permissions";
import { nodesQuery, rolesQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Select } from "@/components/ui/select";

const issuesToErrors = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) => {
  const out: Record<string, string> = {};
  for (const i of issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
};

export function bindingLabel(
  b: Pick<RoleBinding, "roleName" | "scopeType" | "scopeName" | "scopeId">,
): string {
  if (b.scopeType === "global") return `${b.roleName} · everywhere`;
  return `${b.roleName} · ${b.scopeType} ${b.scopeName ?? b.scopeId ?? ""}`.trim();
}

/** How many of a role's permissions take effect when bound at `scope`. */
export function applicablePermissions(
  role: Pick<Role, "permissions">,
  scope: ScopeType,
): { applies: number; total: number } {
  const total = role.permissions.length;
  const applies = role.permissions.filter((p) =>
    p in PERMISSIONS ? permissionAllowsScope(p, scope) : false,
  ).length;
  return { applies, total };
}

function isPrivileged(roleKey: string): boolean {
  return (PRIVILEGED_ROLES as readonly string[]).includes(roleKey);
}

export function CreateUserDialog({
  open,
  onOpenChange,
  me,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  me: Me;
}) {
  const roles = useQuery({ ...rolesQuery, enabled: open });
  const owner = isOwner(me);
  const [form, setForm] = useState({
    email: "",
    displayName: "",
    password: "",
    confirm: "",
    roleKey: "none",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setForm({ email: "", displayName: "", password: "", confirm: "", roleKey: "none" });
      setErrors({});
    }
  }, [open]);
  const create = useApiMutation({
    mutationFn: (body: z.input<typeof CreateUserRequest>) => usersApi.create(body),
    success: (u) => `User ${u.email} created`,
    errorTitle: "Could not create user",
    sensitive: true,
    invalidate: [qk.users.all],
    onSuccess: () => onOpenChange(false),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateUserRequest.safeParse({
      email: form.email,
      displayName: form.displayName,
      password: form.password,
      roles: form.roleKey === "none" ? [] : [{ roleKey: form.roleKey, scopeType: "global", scopeId: null }],
    });
    const next = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (form.password !== form.confirm) next.confirm = "Passwords do not match.";
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    create.mutate(parsed.data, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>
              Share the initial password through a secure channel; the user can change it under Settings.
            </DialogDescription>
          </DialogHeader>
          <Field label="Email" error={errors.email} required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email")(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Display name" error={errors.displayName} required>
            <Input
              value={form.displayName}
              onChange={(e) => set("displayName")(e.target.value)}
              maxLength={80}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Initial password" error={errors.password} hint="At least 12 characters." required>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => set("password")(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm password" error={errors.confirm} required>
              <Input
                type="password"
                value={form.confirm}
                onChange={(e) => set("confirm")(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Field
            label="Role"
            hint="Granted installation-wide. Add scoped roles afterwards from “Manage roles”."
            error={errors.roles}
          >
            <Select
              value={form.roleKey}
              onValueChange={set("roleKey")}
              options={[
                { value: "none", label: "No role (cannot see anything yet)" },
                ...(roles.data ?? []).map((r) => ({
                  value: r.key,
                  label: isPrivileged(r.key) && !owner ? `${r.name} (owner only)` : r.name,
                  disabled: isPrivileged(r.key) && !owner,
                })),
              ]}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditUserDialog({
  user,
  me,
  onOpenChange,
}: {
  user: User | null;
  me: Me;
  onOpenChange: (o: boolean) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<User["status"]>("active");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setStatus(user.status);
      setErrors({});
    }
  }, [user]);
  const save = useApiMutation({
    mutationFn: (body: z.input<typeof UpdateUserRequest>) => usersApi.update(user!.id, body),
    success: "User saved",
    errorTitle: "Could not save user",
    // Editing yourself changes your own session's Me (name, status).
    invalidate: user?.id === me.user.id ? [qk.users.all, qk.auth.me] : [qk.users.all],
    onSuccess: () => onOpenChange(false),
  });
  const self = user?.id === me.user.id;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const body: z.input<typeof UpdateUserRequest> = {};
    if (displayName.trim() !== user.displayName) body.displayName = displayName.trim();
    if (status !== user.status) body.status = status;
    const parsed = UpdateUserRequest.safeParse(body);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    if (Object.keys(parsed.data).length === 0) return onOpenChange(false);
    save.mutate(parsed.data, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  return (
    <Dialog open={user !== null} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>{user?.email}</DialogDescription>
          </DialogHeader>
          <Field label="Display name" error={errors.displayName}>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
          </Field>
          <Field
            label="Status"
            error={errors.status}
            hint={
              self
                ? "You cannot disable your own account."
                : "Disabled users cannot sign in; their sessions end."
            }
          >
            <Select
              value={status}
              onValueChange={setStatus}
              disabled={self}
              options={[
                { value: "active", label: "Active" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: User | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setPassword("");
    setConfirm("");
    setErrors({});
  }, [user]);
  const reset = useApiMutation({
    mutationFn: (pw: string) => usersApi.resetPassword(user!.id, { password: pw }),
    success: "Password reset; the user's sessions were signed out",
    errorTitle: "Could not reset password",
    sensitive: true,
    onSuccess: () => onOpenChange(false),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = Password.safeParse(password);
    const next: Record<string, string> = {};
    if (!parsed.success) next.password = parsed.error.issues[0]?.message ?? "Invalid password";
    if (password !== confirm) next.confirm = "Passwords do not match.";
    setErrors(next);
    if (Object.keys(next).length) return;
    reset.mutate(password);
  };
  return (
    <Dialog open={user !== null} onOpenChange={(o) => !reset.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Sets a new password for {user?.email} and signs out all of their sessions.
            </DialogDescription>
          </DialogHeader>
          <Field label="New password" error={errors.password} hint="At least 12 characters.">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm password" error={errors.confirm}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={reset.isPending}>
              Reset password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResetMfaDialog({
  user,
  me,
  onOpenChange,
}: {
  user: User | null;
  me: Me;
  onOpenChange: (o: boolean) => void;
}) {
  const reset = useApiMutation({
    mutationFn: () => usersApi.resetMfa(user!.id),
    success: "Two-factor authentication reset",
    errorTitle: "Could not reset MFA",
    invalidate: user?.id === me.user.id ? [qk.users.all, qk.auth.me] : [qk.users.all],
    onSuccess: () => onOpenChange(false),
  });
  return (
    <ConfirmDialog
      open={user !== null}
      onOpenChange={onOpenChange}
      title="Reset two-factor authentication?"
      description={`${user?.email ?? "The user"} will sign in with their password only until they enrol a new authenticator. Do this only after verifying their identity.`}
      confirmLabel="Reset MFA"
      destructive
      pending={reset.isPending}
      onConfirm={() => reset.mutate()}
    />
  );
}

type ScopeChoice = "global" | "node" | "network" | "server";

export function RoleBindingsDialog({
  user,
  me,
  onOpenChange,
}: {
  user: User | null;
  me: Me;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const open = user !== null;
  const roles = useQuery({ ...rolesQuery, enabled: open });
  const nodes = useQuery({ ...nodesQuery, enabled: open });
  const owner = isOwner(me);
  const [roleKey, setRoleKey] = useState<string | undefined>(undefined);
  const [scopeType, setScopeType] = useState<ScopeChoice>("global");
  const [scopeId, setScopeId] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<RoleBinding | null>(null);
  const [current, setCurrent] = useState<User | null>(user);
  useEffect(() => {
    setCurrent(user);
    setRoleKey(undefined);
    setScopeType("global");
    setScopeId(undefined);
  }, [user]);

  const onUser = (u: User) => {
    setCurrent(u);
    void queryClient.invalidateQueries({ queryKey: qk.users.all });
    // Changing your own roles changes your permissions: refresh Me so the UI gates update.
    if (u.id === me.user.id) void queryClient.invalidateQueries({ queryKey: qk.auth.me });
  };
  const add = useApiMutation({
    mutationFn: () =>
      usersApi.addRole(user!.id, {
        roleKey: roleKey!,
        scopeType,
        scopeId: scopeType === "global" ? null : (scopeId ?? null),
      }),
    success: "Role granted",
    errorTitle: "Could not grant role",
    onSuccess: (u) => {
      onUser(u);
      setRoleKey(undefined);
      setScopeId(undefined);
    },
  });
  const remove = useApiMutation({
    mutationFn: (bindingId: string) => usersApi.removeRole(user!.id, bindingId),
    success: "Role removed",
    errorTitle: "Could not remove role",
    onSuccess: (u) => {
      onUser(u);
      setRemoving(null);
    },
  });

  const role = useMemo(() => roles.data?.find((r) => r.key === roleKey), [roles.data, roleKey]);
  const applicable = role ? applicablePermissions(role, scopeType) : null;
  const ready = !!roleKey && (scopeType === "global" || !!scopeId);
  const self = user?.id === me.user.id;

  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && !remove.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Roles for {current?.displayName}</DialogTitle>
          <DialogDescription>
            Roles grant permissions everywhere or on a specific node. Network and server scopes arrive with
            those features.
          </DialogDescription>
        </DialogHeader>
        <section aria-label="Current roles" className="flex flex-col gap-1.5">
          {(current?.roles ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No roles: this user can sign in but sees nothing.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {(current?.roles ?? []).map((b) => {
                const locked = isPrivileged(b.roleKey) && !owner;
                return (
                  <li key={b.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{b.roleName}</span>{" "}
                      <span className="text-muted-foreground">
                        {b.scopeType === "global"
                          ? "· everywhere"
                          : `· ${b.scopeType} ${b.scopeName ?? b.scopeId}`}
                      </span>
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={locked}
                      title={locked ? "Only an owner can remove this role" : undefined}
                      aria-label={`Remove ${bindingLabel(b)}`}
                      onClick={() => setRemoving(b)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section aria-label="Grant a role" className="flex flex-col gap-3 rounded-md border p-3">
          <h3 className="text-sm font-semibold">Grant a role</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role">
              <Select
                value={roleKey}
                onValueChange={setRoleKey}
                placeholder={roles.isPending ? "Loading roles…" : "Choose a role"}
                options={(roles.data ?? []).map((r) => ({
                  value: r.key,
                  label: isPrivileged(r.key) && !owner ? `${r.name} (owner only)` : r.name,
                  disabled: isPrivileged(r.key) && !owner,
                }))}
              />
            </Field>
            <Field label="Scope">
              <Select
                value={scopeType}
                onValueChange={(v) => {
                  setScopeType(v);
                  setScopeId(undefined);
                }}
                options={[
                  { value: "global", label: "Everywhere" },
                  { value: "node", label: "A node" },
                  { value: "network", label: "A network (Phase 5)", disabled: true },
                  { value: "server", label: "A server (Phase 3)", disabled: true },
                ]}
              />
            </Field>
            {scopeType === "node" ? (
              <Field label="Node" className="sm:col-span-2">
                <Select
                  value={scopeId}
                  onValueChange={setScopeId}
                  placeholder={nodes.isPending ? "Loading nodes…" : "Choose a node"}
                  options={(nodes.data ?? []).map((n) => ({ value: n.id, label: n.name }))}
                />
              </Field>
            ) : null}
          </div>
          {role ? <p className="text-xs text-muted-foreground">{role.description}</p> : null}
          {applicable && scopeType !== "global" && applicable.applies < applicable.total ? (
            <Callout tone="info">
              {applicable.applies} of {applicable.total} permissions in this role apply at {scopeType} scope;
              installation-wide permissions (such as user management) have no effect here.
            </Callout>
          ) : null}
          <div className="flex justify-end">
            <Button disabled={!ready} loading={add.isPending} onClick={() => add.mutate()}>
              Grant role
            </Button>
          </div>
        </section>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(o) => !o && setRemoving(null)}
          title="Remove role?"
          description={
            <>
              {removing ? bindingLabel(removing) : ""} will be removed from {current?.displayName}.
              {self ? " You are removing one of your own roles and may lose access immediately." : ""}
            </>
          }
          confirmLabel="Remove role"
          destructive
          pending={remove.isPending}
          onConfirm={() => removing && remove.mutate(removing.id)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function RoleBadges({ roles }: { roles: RoleBinding[] }) {
  if (roles.length === 0) return <span className="text-xs text-muted-foreground">No roles</span>;
  return (
    <div className="flex max-w-80 flex-wrap gap-1">
      {roles.map((b) => (
        <Badge
          key={b.id}
          variant={b.scopeType === "global" ? "secondary" : "outline"}
          title={bindingLabel(b)}
        >
          {b.roleName}
          {b.scopeType !== "global" ? (
            <span className="font-normal text-muted-foreground">· {b.scopeName ?? b.scopeType}</span>
          ) : null}
        </Badge>
      ))}
    </div>
  );
}
