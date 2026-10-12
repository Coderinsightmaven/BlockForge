import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ALERT_RULE_KINDS, AlertRuleKind } from "@blockforge/contracts";
import { ApiError, fieldErrorsFrom } from "./api/errors";
import { useApiMutation } from "./mutations";
import type { ApiMutationOptions } from "./mutations";
import { createQueryClient } from "./queries";
import { RULE_KINDS } from "@/features/alerts/alert-meta";

function harness<TData, TVars>(opts: ApiMutationOptions<TData, TVars>) {
  const qc = createQueryClient();
  const ref: { current: ReturnType<typeof useApiMutation<TData, TVars>> | null } = { current: null };
  function Probe() {
    ref.current = useApiMutation(opts);
    return null;
  }
  const view = render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  const dump = () =>
    JSON.stringify(
      qc
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    );
  return { qc, ref, view, dump };
}

describe("useApiMutation sensitive mode", () => {
  it("never stores the variables and drops the result once settled", async () => {
    let resolve: (v: { secret: string }) => void = () => {};
    const mutationFn = vi.fn(
      (_vars: { password: string }) => new Promise<{ secret: string }>((r) => (resolve = r)),
    );
    const onSuccess = vi.fn();
    const { ref, dump } = harness({ mutationFn, sensitive: true, silentError: true, onSuccess });

    act(() => ref.current!.mutate({ password: "hunter2-hunter2" }));
    await vi.waitFor(() => expect(mutationFn).toHaveBeenCalledWith({ password: "hunter2-hunter2" }));
    expect(dump()).not.toContain("hunter2");
    expect(ref.current!.variables).toBeUndefined();

    await act(async () => resolve({ secret: "one-time-SECRET" }));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess.mock.calls[0]![0]).toEqual({ secret: "one-time-SECRET" });
    await vi.waitFor(() => expect(dump()).not.toContain("one-time-SECRET"));
    await vi.waitFor(() => expect(ref.current!.status).toBe("idle"));
  });

  it("reports errors through onError (the mutation itself resets)", async () => {
    const err = new ApiError({ code: "VALIDATION_FAILED", message: "Invalid code", status: 400 });
    const onError = vi.fn();
    const { ref } = harness({
      mutationFn: (_c: string) => Promise.reject(err),
      sensitive: true,
      silentError: true,
      onError,
    });
    act(() => ref.current!.mutate("123456"));
    // Sensitive mutations never hand the variables back (they are not retained).
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err, undefined));
    await vi.waitFor(() => expect(ref.current!.status).toBe("idle"));
  });

  it("keeps normal mutations' state for inline display", async () => {
    const { ref } = harness({ mutationFn: (n: number) => Promise.resolve(n * 2) });
    act(() => ref.current!.mutate(21));
    await vi.waitFor(() => expect(ref.current!.data).toBe(42));
    expect(ref.current!.variables).toBe(21);
  });
});

describe("contract alignment", () => {
  it("maps ValidationErrorDetails (dot-joined paths) onto top-level form fields", () => {
    const err = new ApiError({
      code: "VALIDATION_FAILED",
      message: "Invalid",
      status: 400,
      details: {
        issues: [
          { path: "gameplay.maxPlayers", message: "Too many" },
          { path: "name", message: "Required" },
          { path: "name", message: "second message ignored" },
          { path: "", message: "Body invalid" },
        ],
      },
    });
    expect(fieldErrorsFrom(err)).toEqual({ gameplay: "Too many", name: "Required", form: "Body invalid" });
    expect(
      fieldErrorsFrom(
        new ApiError({ code: "VALIDATION_FAILED", message: "x", status: 400, details: { issues: "bad" } }),
      ),
    ).toEqual({});
  });

  it("asks for a threshold exactly for the rule kinds whose contract unit is not null", () => {
    for (const kind of AlertRuleKind.options) {
      expect(RULE_KINDS[kind].threshold === null, kind).toBe(ALERT_RULE_KINDS[kind].unit === null);
      expect(RULE_KINDS[kind].description).toBe(ALERT_RULE_KINDS[kind].description);
    }
  });
});
