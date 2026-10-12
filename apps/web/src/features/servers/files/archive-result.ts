import type { Job } from "@blockforge/contracts";
import { toast } from "sonner";
import { jobsApi } from "@/lib/api/servers-api";
import type { FileArchiveOrJob } from "@/lib/api/files-api";
import { formatBytes } from "@/lib/format";
import { baseName } from "./paths";

const TERMINAL = new Set<Job["status"]>(["succeeded", "failed", "cancelled"]);

/** Poll `GET /jobs/:id` until the job finishes (archives of large worlds can take minutes). */
export async function waitForJob(
  jobId: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    get?: (id: string) => Promise<Job>;
  } = {},
): Promise<Job> {
  const get = opts.get ?? ((id: string) => jobsApi.get(id));
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const job = await get(jobId);
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() > deadline) throw new Error("The job is still running; check the folder again later.");
    if (opts.signal?.aborted) throw new DOMException("Stopped waiting", "AbortError");
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500));
  }
}

/**
 * Report a compress/decompress result. Synchronous results are summarised immediately; background
 * jobs are followed until they finish, then `onDone` refreshes the listing.
 */
export function reportArchiveResult(
  r: FileArchiveOrJob,
  verb: "Archive created" | "Archive extracted",
  onDone: () => void,
): void {
  if ("jobId" in r) {
    toast.info(`${verb === "Archive created" ? "Compressing" : "Extracting"} in the background…`);
    void waitForJob(r.jobId)
      .then((job) => {
        if (job.status === "succeeded") toast.success(verb);
        else
          toast.error(
            verb === "Archive created" ? "Could not create the archive" : "Could not extract the archive",
            {
              description: job.error?.message ?? job.status,
            },
          );
      })
      .catch((err: unknown) =>
        toast.error("Lost track of the archive job", {
          description: err instanceof Error ? err.message : undefined,
        }),
      )
      .finally(onDone);
    return;
  }
  toast.success(verb, { description: `${baseName(r.path)} · ${r.entries} entries · ${formatBytes(r.size)}` });
  onDone();
}
