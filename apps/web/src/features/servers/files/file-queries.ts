import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { filesApi } from "@/lib/api/files-api";
import { qk } from "@/lib/query-keys";

export const fileListQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: qk.server(id).files(path),
    queryFn: ({ signal }) => filesApi.list(id, path, signal),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });

export const fileSearchQuery = (id: string, path: string, q: string) =>
  queryOptions({
    queryKey: qk.server(id).search(path, q),
    queryFn: ({ signal }) => filesApi.search(id, path, q, signal),
    staleTime: 5_000,
  });
