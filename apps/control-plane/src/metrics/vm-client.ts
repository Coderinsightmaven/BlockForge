import { z } from "zod";
import { errorMessage, upstreamError } from "../lib/errors.js";

const MatrixResponse = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.number(), z.string()])),
      }),
    ),
  }),
});
export type MatrixResult = z.infer<typeof MatrixResponse>["data"]["result"];

export class VmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async queryRange(query: string, startMs: number, endMs: number, stepMs: number): Promise<MatrixResult> {
    const params = new URLSearchParams({
      query,
      start: (startMs / 1000).toFixed(3),
      end: (endMs / 1000).toFixed(3),
      step: `${Math.round(stepMs / 1000)}s`,
      // Always compute fresh results so the newest points are not hidden by VictoriaMetrics' cache.
      nocache: "1",
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1/query_range`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw upstreamError("Metrics store unreachable", { reason: errorMessage(err) });
    }
    const text = await res.text();
    if (!res.ok) throw upstreamError(`Metrics store returned HTTP ${res.status}`, { body: text.slice(0, 500) });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw upstreamError("Metrics store returned invalid JSON");
    }
    const parsed = MatrixResponse.safeParse(json);
    if (!parsed.success) throw upstreamError("Unexpected metrics store response");
    return parsed.data.data.result;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }
}
