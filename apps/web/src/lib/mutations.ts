import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MutateOptions, QueryKey, UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { describeError } from "./api/errors";

export function toastError(err: unknown, title?: string): void {
  const d = describeError(err);
  toast.error(title ?? d.title, {
    description: title ? [d.title, d.detail].filter(Boolean).join(" — ") : (d.detail ?? undefined),
  });
}

export interface ApiMutationOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Success toast; omit for silent success. (`vars` is undefined for sensitive mutations.) */
  success?: string | ((data: TData, vars: TVars) => string);
  /** Prefix for the error toast, e.g. "Could not revoke node". */
  errorTitle?: string;
  /** Query prefixes to invalidate after success. */
  invalidate?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  onError?: (err: unknown) => void;
  /** Suppress the error toast (the caller renders the error inline instead). */
  silentError?: boolean;
  /**
   * The request or response carries a secret (password, TOTP code, webhook URL, one-time token,
   * MFA seed). The variables never enter the mutation cache — they travel through a ref — and the
   * mutation is reset as soon as it settles, so neither `variables` nor `data` outlive the
   * callbacks. Copy what the UI must show into component state in `onSuccess`; keep errors that
   * are rendered inline via `onError`.
   */
  sensitive?: boolean;
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
  const sensitive = !!opts.sensitive;
  const payload = useRef<{ vars: TVars } | null>(null);
  const resetRef = useRef<() => void>(() => {});

  const mutation = useMutation<TData, unknown, TVars>({
    mutationFn: (vars) => {
      if (!sensitive) return opts.mutationFn(vars);
      const p = payload.current;
      payload.current = null;
      if (!p) return Promise.reject(new Error("The request payload is no longer available; try again."));
      return opts.mutationFn(p.vars);
    },
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
      opts.onError?.(err);
    },
    onSettled: () => {
      if (!sensitive) return;
      payload.current = null;
      // Runs after TanStack dispatched the final state and the per-call callbacks.
      setTimeout(() => resetRef.current(), 0);
    },
  });
  resetRef.current = mutation.reset;
  if (!sensitive) return mutation;

  type Options = MutateOptions<TData, unknown, TVars>;
  const mutate = ((vars: TVars, options?: Options) => {
    payload.current = { vars };
    mutation.mutate(undefined as TVars, options);
  }) as typeof mutation.mutate;
  const mutateAsync = ((vars: TVars, options?: Options) => {
    payload.current = { vars };
    return mutation.mutateAsync(undefined as TVars, options);
  }) as typeof mutation.mutateAsync;
  return { ...mutation, mutate, mutateAsync } as UseMutationResult<TData, unknown, TVars>;
}
