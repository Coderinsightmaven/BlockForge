import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey, UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { describeError } from "./api/errors";

export function toastError(err: unknown, title?: string): void {
  const d = describeError(err);
  toast.error(title ?? d.title, {
    description: title ? [d.title, d.detail].filter(Boolean).join(" — ") : (d.detail ?? undefined),
  });
}

interface ApiMutationOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Success toast; omit for silent success. */
  success?: string | ((data: TData, vars: TVars) => string);
  /** Prefix for the error toast, e.g. "Could not revoke node". */
  errorTitle?: string;
  /** Query prefixes to invalidate after success. */
  invalidate?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  /** Suppress the error toast (the caller renders the error inline instead). */
  silentError?: boolean;
}

/**
 * Every mutation in the app goes through this: pending state via the returned mutation,
 * a success toast, invalidation of affected queries, and an error toast carrying the API code
 * and request id.
 */
export function useApiMutation<TData, TVars = void>(
  opts: ApiMutationOptions<TData, TVars>,
): UseMutationResult<TData, unknown, TVars> {
  const queryClient = useQueryClient();
  return useMutation<TData, unknown, TVars>({
    mutationFn: opts.mutationFn,
    onSuccess: async (data, vars) => {
      if (opts.success)
        toast.success(typeof opts.success === "function" ? opts.success(data, vars) : opts.success);
      await Promise.all(
        (opts.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      await opts.onSuccess?.(data, vars);
    },
    onError: (err) => {
      if (!opts.silentError) toastError(err, opts.errorTitle);
    },
  });
}
