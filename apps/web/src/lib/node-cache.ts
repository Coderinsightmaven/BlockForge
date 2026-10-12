import { replaceEqualDeep } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { Node } from "@blockforge/contracts";
import { qk } from "./query-keys";

/*
 * `Node.latest` arrives from two places: REST (`GET /nodes`, `GET /nodes/:id`, `node.updated`
 * events) and the much more frequent `node.metrics` realtime stream. A REST response can be
 * older than the live sample already on screen, so the newest sample always wins.
 */

/** `incoming`, but keeping `cached.latest` when it is newer than the incoming sample. */
export function mergeNodeLatest(incoming: Node, cached: Node | undefined): Node {
  const keep = cached?.latest;
  if (!keep || cached.id !== incoming.id) return incoming;
  if (incoming.latest && incoming.latest.ts >= keep.ts) return incoming;
  return { ...incoming, latest: keep };
}

export function mergeNodeList(incoming: readonly Node[], cached: readonly Node[] | undefined): Node[] {
  if (!cached?.length) return [...incoming];
  const byId = new Map(cached.map((n) => [n.id, n]));
  return incoming.map((n) => mergeNodeLatest(n, byId.get(n.id)));
}

/** `structuralSharing` for `GET /nodes`: merge, then keep unchanged references for cheap renders. */
export function shareNodeList(oldData: unknown, newData: unknown): unknown {
  const merged = mergeNodeList(newData as Node[], oldData as Node[] | undefined);
  return replaceEqualDeep(oldData, merged);
}

/** `structuralSharing` for `GET /nodes/:id`. */
export function shareNode(oldData: unknown, newData: unknown): unknown {
  const merged = mergeNodeLatest(newData as Node, oldData as Node | undefined);
  return replaceEqualDeep(oldData, merged);
}

/** Write a node (e.g. from `node.updated` or a mutation response) into the list and detail caches. */
export function upsertNodeInCache(queryClient: QueryClient, node: Node): void {
  queryClient.setQueryData<Node[]>(qk.nodes.list, (list) => {
    if (!list) return list;
    const i = list.findIndex((n) => n.id === node.id);
    if (i === -1) return [...list, node];
    const next = list.slice();
    next[i] = mergeNodeLatest(node, list[i]);
    return next;
  });
  queryClient.setQueryData<Node>(qk.nodes.detail(node.id), (cached) => mergeNodeLatest(node, cached));
}
