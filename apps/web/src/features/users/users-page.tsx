import { useInfiniteQuery } from "@tanstack/react-query";
import { EllipsisVertical, KeyRound, Pencil, Search, ShieldCheck, ShieldOff, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Me, User } from "@blockforge/contracts";
import { hasGlobal } from "@/lib/permissions";
import { usersQuery } from "@/lib/queries";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";
import { StatusBadge, USER_STATUS_META, statusMeta } from "@/components/ui/status";
import {
  SortableHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSort,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RolesMatrix } from "./roles-matrix";
import {
  CreateUserDialog,
  EditUserDialog,
  ResetMfaDialog,
  ResetPasswordDialog,
  RoleBadges,
  RoleBindingsDialog,
} from "./user-dialogs";

export type UsersTab = "users" | "roles";

const accessors = {
  name: (u: User) => u.displayName,
  email: (u: User) => u.email,
  status: (u: User) => u.status,
  lastLogin: (u: User) => u.lastLoginAt,
  created: (u: User) => u.createdAt,
};

export function matchesUser(u: User, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return [u.displayName, u.email, u.username, ...u.roles.map((r) => r.roleName)].some((v) =>
    v.toLowerCase().includes(n),
  );
}

type DialogState = { kind: "edit" | "password" | "mfa" | "roles"; user: User } | null;

export function UsersPage({
  me,
  tab,
  q,
  create,
  onTabChange,
  onQueryChange,
  onCreateHandled,
}: {
  me: Me;
  tab: UsersTab;
  q: string;
  create: boolean;
  onTabChange: (t: UsersTab) => void;
  onQueryChange: (q: string) => void;
  onCreateHandled: () => void;
}) {
  const allowed = hasGlobal(me, "users.view");
  const canManage = hasGlobal(me, "users.manage");
  const users = useInfiniteQuery({ ...usersQuery, enabled: allowed });
  const [createOpen, setCreateOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  useEffect(() => {
    if (create && canManage) {
      setCreateOpen(true);
      onCreateHandled();
    }
  }, [create, canManage, onCreateHandled]);

  const all = useMemo(() => users.data?.pages.flatMap((p) => p.items) ?? [], [users.data]);
  const filtered = useMemo(() => all.filter((u) => matchesUser(u, q)), [all, q]);
  const { sorted, sort, toggle } = useSort(filtered, accessors, { key: "name", direction: "asc" });
  const virtual = useVirtualRows(sorted, { estimateSize: 53, getKey: (u) => u.id });

  if (!allowed) return <NoPermission what="view users" />;
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title="Users & Permissions"
        description="Accounts, their roles, and what each role allows."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <UserPlus aria-hidden />
              Create user
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as UsersTab)}>
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles & permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <Card>
            <div className="flex items-center gap-2 border-b p-2.5">
              <div className="relative w-full max-w-xs">
                <Search
                  className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={q}
                  onChange={(e) => onQueryChange(e.target.value)}
                  placeholder="Search name, username, email, role…"
                  aria-label="Search users"
                  className="pl-8"
                />
              </div>
            </div>
            {users.isPending ? (
              <TableSkeleton columns={6} />
            ) : users.isError && !users.data ? (
              <ErrorState
                error={users.error}
                onRetry={() => void users.refetch()}
                title="Could not load users"
              />
            ) : sorted.length === 0 ? (
              <EmptyState icon={Search} title={q ? "No users match your search" : "No users"} compact />
            ) : (
              <>
                <VirtualTable scrollRef={virtual.scrollRef} rowCount={sorted.length}>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow className="hover:bg-transparent" aria-rowindex={1}>
                      <SortableHead column="name" sort={sort} onSort={toggle}>
                        User
                      </SortableHead>
                      <SortableHead column="status" sort={sort} onSort={toggle}>
                        Status
                      </SortableHead>
                      <TableHead>MFA</TableHead>
                      <TableHead>Roles</TableHead>
                      <SortableHead column="lastLogin" sort={sort} onSort={toggle}>
                        Last sign-in
                      </SortableHead>
                      <SortableHead column="created" sort={sort} onSort={toggle}>
                        Created
                      </SortableHead>
                      {canManage ? (
                        <TableHead className="text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <SpacerRow height={virtual.padTop} colSpan={canManage ? 7 : 6} />
                    {virtual.items.map((vi) => {
                      const u = sorted[vi.index]!;
                      return (
                        <TableRow
                          key={vi.key}
                          ref={virtual.virtualizer.measureElement}
                          data-index={vi.index}
                          aria-rowindex={vi.index + 2}
                        >
                          <TableCell>
                            <div className="font-medium">
                              {u.displayName}
                              {u.id === me.user.id ? (
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                  (you)
                                </span>
                              ) : null}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              <code className="font-mono">{u.username}</code> · {u.email}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge meta={statusMeta(USER_STATUS_META, u.status)} />
                          </TableCell>
                          <TableCell>
                            {u.mfaEnabled ? (
                              <Badge tone="success">
                                <ShieldCheck aria-hidden /> On
                              </Badge>
                            ) : (
                              <Badge tone="neutral">
                                <ShieldOff aria-hidden /> Off
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <RoleBadges roles={u.roles} />
                          </TableCell>
                          <TableCell className="text-xs">
                            <Timestamp ts={u.lastLoginAt} />
                          </TableCell>
                          <TableCell className="text-xs">
                            <Timestamp ts={u.createdAt} />
                          </TableCell>
                          {canManage ? (
                            <TableCell className="text-right">
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`Actions for ${u.displayName}`}
                                  >
                                    <EllipsisVertical aria-hidden />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", user: u })}>
                                    <Pencil aria-hidden /> Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => setDialog({ kind: "roles", user: u })}>
                                    <ShieldCheck aria-hidden /> Manage roles
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => setDialog({ kind: "password", user: u })}>
                                    <KeyRound aria-hidden /> Reset password
                                  </DropdownMenuItem>
                                  {u.mfaEnabled ? (
                                    <DropdownMenuItem
                                      destructive
                                      onSelect={() => setDialog({ kind: "mfa", user: u })}
                                    >
                                      <ShieldOff aria-hidden /> Reset MFA
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                    <SpacerRow height={virtual.padBottom} colSpan={canManage ? 7 : 6} />
                  </TableBody>
                </VirtualTable>
                {users.hasNextPage ? (
                  <div className="flex justify-center border-t p-2">
                    <Button
                      size="sm"
                      variant="outline"
                      loading={users.isFetchingNextPage}
                      onClick={() => void users.fetchNextPage()}
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="roles">
          <RolesMatrix />
        </TabsContent>
      </Tabs>
      {canManage ? (
        <>
          <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} me={me} />
          <EditUserDialog
            user={dialog?.kind === "edit" ? dialog.user : null}
            me={me}
            onOpenChange={(o) => !o && close()}
          />
          <ResetPasswordDialog
            user={dialog?.kind === "password" ? dialog.user : null}
            onOpenChange={(o) => !o && close()}
          />
          <ResetMfaDialog
            user={dialog?.kind === "mfa" ? dialog.user : null}
            me={me}
            onOpenChange={(o) => !o && close()}
          />
          <RoleBindingsDialog
            user={dialog?.kind === "roles" ? dialog.user : null}
            me={me}
            onOpenChange={(o) => !o && close()}
          />
        </>
      ) : null}
    </>
  );
}
