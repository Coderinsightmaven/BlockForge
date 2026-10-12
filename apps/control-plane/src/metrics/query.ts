import { METRIC_SERIES, type MetricSeriesId, type MetricSeriesResult } from "@blockforge/contracts";
import { badRequest } from "../lib/errors.js";
import { buildSeriesQueries, chooseStepMs, fillGrid, SeriesQueryError, stepGrid, type SeriesTarget } from "./series.js";
import type { VmClient } from "./vm-client.js";

const MAX_RANGE_MS = 400 * 24 * 60 * 60_000;

/** Executes whitelisted series queries and shapes them as `MetricSeriesResult` with null-filled gaps. */
export class MetricsQueryService {
  constructor(private readonly vm: VmClient) {}

  async range(q: { series: MetricSeriesId; from: number; to: number; stepMs?: number | undefined }, target: SeriesTarget): Promise<MetricSeriesResult> {
    if (q.to <= q.from) throw badRequest("`to` must be after `from`");
    if (q.to - q.from > MAX_RANGE_MS) throw badRequest("Time range too large");
    const stepMs = chooseStepMs(q.from, q.to, q.stepMs);
    const grid = stepGrid(q.from, q.to, stepMs);
    const meta = METRIC_SERIES[q.series];
    const base: MetricSeriesResult = { series: q.series, unit: meta.unit, from: q.from, to: q.to, stepMs, lines: [] };
    const subjectIds = q.series === "global.players" ? (target.serverIds ?? target.nodeIds) : target.nodeIds;
    if (subjectIds !== undefined && subjectIds !== "all" && subjectIds.length === 0) return base;
    let subs;
    try {
      subs = buildSeriesQueries(q.series, target, stepMs);
    } catch (err) {
      if (err instanceof SeriesQueryError) throw badRequest(err.message);
      throw err;
    }
    const start = grid[0] ?? q.from;
    const end = grid[grid.length - 1] ?? q.to;
    const results = await Promise.all(subs.map((s) => this.vm.queryRange(s.promql, start, end, stepMs)));
    subs.forEach((sub, i) => {
      for (const r of results[i] ?? []) {
        const labels: Record<string, string> = { ...sub.labels };
        for (const k of sub.keep) {
          const v = r.metric[k];
          if (v !== undefined) labels[k] = v;
        }
        base.lines.push({ labels, points: fillGrid(grid, r.values) });
      }
    });
    base.lines.sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels), "en", { numeric: true }));
    return base;
  }
}
