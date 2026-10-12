import { useInfiniteQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState } from "react";
import { PlayerName } from "@blockforge/contracts";
import type { Server } from "@blockforge/contracts";
import { playersApi } from "@/lib/api/players-api";
import { formatDuration } from "@/lib/format";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/* Players → Sessions (its own chunk, loaded after the tab's first paint). */

export default function SessionsCard({ server }: { server: Server }) {
  const [filter, setFilter] = useState("");
  const name = filter.trim();
  const valid = name === "" || PlayerName.safeParse(name).success;
  const q = useInfiniteQuery({
    queryKey: qk.server(server.id).playerSessions(name),
    queryFn: ({ signal, pageParam }) =>
      playersApi.sessions(server.id, { limit: 50, cursor: pageParam, name }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: valid,
  });
  const sessions = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Joins and leaves from the server log (kept 90 days).</CardDescription>
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name"
          aria-label="Filter sessions by player name"
          maxLength={16}
          className="w-44"
        />
      </CardHeader>
      {!valid ? (
        <p className="px-4 pb-3 text-xs text-danger">1–16 letters, digits or underscores.</p>
      ) : q.isPending ? (
        <TableSkeleton columns={4} rows={3} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load sessions"
          compact
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={Users}
          title={name ? "No sessions for this name" : "No sessions recorded yet"}
          compact
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Player</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Left</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-sm font-medium">{s.name}</TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={s.joinedAt} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.leftAt ? <Timestamp ts={s.leftAt} /> : <Badge tone="success">Online</Badge>}
                  </TableCell>
                  <TableCell className="text-xs tabular">
                    {s.leftAt ? formatDuration(s.leftAt - s.joinedAt) : "—"}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs break-words text-muted-foreground">
                    {s.leaveReason ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {q.hasNextPage ? (
        <div className="flex justify-center p-2">
          <Button
            size="sm"
            variant="outline"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load older sessions
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
