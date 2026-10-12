import type { MetricSeriesId } from "@blockforge/contracts";

/** Node metric charts (node page Metrics tab, monitoring comparison). Kept apart from the page. */
export const NODE_CHARTS: Array<{ series: MetricSeriesId; title: string; info?: string }> = [
  { series: "node.cpu.usage", title: "CPU usage", info: "Whole-host CPU utilisation." },
  {
    series: "node.cpu.core",
    title: "CPU per core",
    info: "One line per logical core. With many cores the lines share one colour; hover or use the table for exact values.",
  },
  {
    series: "node.load",
    title: "Load average",
    info: "Runnable tasks averaged over 1, 5 and 15 minutes. Compare with the logical core count.",
  },
  { series: "node.memory", title: "Memory", info: "Used, cached/buffers and available memory." },
  { series: "node.swap.used", title: "Swap used" },
  { series: "node.fs.used", title: "Filesystem usage", info: "Used space per mount point." },
  { series: "node.disk.throughput", title: "Disk throughput", info: "Read / write rate per device." },
  {
    series: "node.disk.latency",
    title: "Disk latency",
    info: "Average time per completed I/O request, where the platform reports it.",
  },
  {
    series: "node.net.throughput",
    title: "Network throughput",
    info: "Receive / transmit rate per interface.",
  },
  { series: "node.net.errors", title: "Network errors", info: "Interface errors and drops per second." },
];
