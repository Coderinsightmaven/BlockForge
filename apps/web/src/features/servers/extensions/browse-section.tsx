import { useQuery } from "@tanstack/react-query";
import { PackageSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { ModrinthCategoryTag } from "@blockforge/contracts";
import type { Server } from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import type { ModrinthSearchParams } from "@/lib/api/extensions-api";
import { isApiError } from "@/lib/api/errors";
import { formatNumber } from "@/lib/format";
import { qk } from "@/lib/query-keys";
import { useDebounced } from "@/lib/use-debounced";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ExtensionIcon } from "./extension-ui";

/* Plugins & mods → Browse Modrinth (its own chunk, loaded when the section is opened). */

const CATEGORIES = [
  "adventure",
  "economy",
  "game-mechanics",
  "library",
  "management",
  "minigame",
  "optimization",
  "social",
  "storage",
  "technology",
  "transportation",
  "utility",
  "worldgen",
].filter((c) => ModrinthCategoryTag.safeParse(c).success);

const SORTS = [
  { value: "relevance" as const, label: "Relevance" },
  { value: "downloads" as const, label: "Downloads" },
  { value: "follows" as const, label: "Follows" },
  { value: "newest" as const, label: "Newest" },
  { value: "updated" as const, label: "Recently updated" },
];
const PAGE = 20;

export default function BrowseSection({
  server,
  onOpen,
  onPrefetchOpen,
}: {
  server: Server;
  onOpen: (project: string) => void;
  /** Hover/focus of a "View" button: start loading the project dialog. */
  onPrefetchOpen?: () => void;
}) {
  const [text, setText] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [sort, setSort] = useState<NonNullable<ModrinthSearchParams["sort"]>>("relevance");
  const [offset, setOffset] = useState(0);
  const query = useDebounced(text.trim(), 350);
  useEffect(() => setOffset(0), [query, categories, sort]);
  const params: ModrinthSearchParams = { query, categories, sort, offset, limit: PAGE };
  const q = useQuery({
    queryKey: qk.server(server.id).modrinthSearch(params),
    queryFn: ({ signal }) => extensionsApi.search(server.id, params, signal),
    staleTime: 60_000,
  });
  const toggleCategory = (c: string) =>
    setCategories((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c].slice(0, 8)));
  const rateLimited = isApiError(q.error) && q.error.code === "RATE_LIMITED";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search Modrinth"
          aria-label="Search Modrinth"
          maxLength={256}
          className="max-w-sm"
        />
        <Select value={sort} onValueChange={setSort} options={SORTS} aria-label="Sort by" className="w-44" />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <Button
            key={c}
            size="sm"
            variant={categories.includes(c) ? "default" : "outline"}
            aria-pressed={categories.includes(c)}
            className="h-6 px-2 text-xs"
            onClick={() => toggleCategory(c)}
          >
            {c}
          </Button>
        ))}
      </div>
      {q.isPending ? (
        <TableSkeleton columns={3} rows={4} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title={
            rateLimited
              ? "Modrinth is rate-limiting requests — try again in a moment"
              : "Could not search Modrinth"
          }
          compact
        />
      ) : q.data.hits.length === 0 ? (
        <EmptyState icon={PackageSearch} title="Nothing found for this server" compact />
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {q.data.hits.map((h) => (
              <li key={h.projectId} className="flex items-start gap-3 p-3">
                <ExtensionIcon url={h.iconUrl} className="size-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium break-words">{h.title}</span>
                    <span className="text-xs text-muted-foreground">by {h.author}</span>
                    {h.installed ? <Badge tone="success">Installed</Badge> : null}
                    {h.loaderMatch === "warning" ? (
                      <Badge
                        tone="warning"
                        title="Only a loader that runs here with a warning matches (e.g. a Quilt mod on Fabric) — it may not work."
                      >
                        Loader warning
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-sm break-words text-muted-foreground">{h.description}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span className="tabular">{formatNumber(h.downloads, 0)} downloads</span>
                    {h.loaders.map((l) => (
                      <Badge key={l} variant="outline" className="font-normal">
                        {l}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`View ${h.title}`}
                  onPointerEnter={onPrefetchOpen}
                  onFocus={onPrefetchOpen}
                  onClick={() => onOpen(h.slug ?? h.projectId)}
                >
                  View
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {q.data.filteredOut > 0
                ? `${q.data.filteredOut} result(s) on this page hidden: they don't run on this server or are client-only.`
                : ""}
            </span>
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <span className="tabular">
                {offset + 1}–{offset + q.data.hits.length + q.data.filteredOut} of{" "}
                {formatNumber(q.data.totalHits, 0)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE >= q.data.totalHits}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
