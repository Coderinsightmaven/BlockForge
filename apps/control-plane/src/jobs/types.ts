import type { JobLogLine, Permission } from "@blockforge/contracts";
import type { z } from "zod";
import type { Tx } from "../db/client.js";

export type JobLogLevel = JobLogLine["level"];

export interface StepContext<I> {
  jobId: string;
  input: I;
  /** 1-based attempt number. */
  attempt: number;
  targetType: string | null;
  targetId: string | null;
  requestedBy: string | null;
  /** Aborted on cancellation or shutdown. Pass it to `gateway.send`. */
  signal: AbortSignal;
  /** Cross-step state, persisted after every step (resumability). Must be JSON-serialisable and secret-free. */
  state: Record<string, unknown>;
  log(level: JobLogLevel, message: string): Promise<void>;
  /** Short status message shown on the current step. */
  setMessage(message: string): Promise<void>;
  /**
   * Persists `state` in one transaction with `fn`'s writes; with `completeStep` the step is also marked
   * succeeded in that transaction (call it last). A crash afterwards resumes from exactly this point, so a
   * step's durable effects (e.g. history rows) are never written twice nor lost apart from its state.
   */
  checkpoint(fn?: (tx: Tx) => Promise<void>, opts?: { completeStep?: boolean }): Promise<void>;
}

/** Returned by a step that does not apply (recorded as `skipped`). */
export const SKIP_STEP = Symbol("skip-step");

export interface JobStepDefinition<I> {
  key: string;
  label: string;
  run(ctx: StepContext<I>): Promise<void | typeof SKIP_STEP>;
}

export interface FinalizeContext<I> {
  jobId: string;
  input: I;
  state: Record<string, unknown>;
  status: "succeeded" | "failed" | "cancelled";
  error: { code: string; message: string } | null;
  log(level: JobLogLevel, message: string): Promise<void>;
}

export interface JobDefinition<I> {
  type: string;
  input: z.ZodType<I>;
  steps: readonly JobStepDefinition<I>[];
  /** Permission (on the job target) needed to cancel; normally the one that started the job. */
  cancelPermission: Permission;
  /** Retries after the first attempt for retryable failures (exponential backoff). */
  retryLimit?: number;
  retryDelaySeconds?: number;
  /** pg-boss expiry for a single attempt. */
  expireInSeconds?: number;
  /** Builds the user-visible result from the final state. */
  result?(state: Record<string, unknown>): unknown;
  /**
   * Runs once as the job reaches a terminal status, before that status is recorded (release
   * operation locks, settle the target's state). Errors are logged and do not change the outcome.
   */
  finalize?(ctx: FinalizeContext<I>): Promise<void>;
}

/** A failure with a stable code. Non-retryable failures end the job immediately. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export interface EnqueueOptions {
  targetType?: string | null;
  targetId?: string | null;
  requestedBy?: string | null;
  idempotencyKey?: string | null;
}
