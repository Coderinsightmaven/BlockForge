import { retryableLazy } from "@/lib/lazy";
import { LazySection } from "@/components/common/chunk-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Steps + live log (virtualised): only needed while a job is shown, so it loads then.
const JobProgressImpl = retryableLazy(() =>
  import("./server-jobs").then((m) => ({ default: m.JobProgress })),
);

/** Shown while the job widget loads: the job's title and the same "Loading job…" line, no progress. */
export function JobProgressLoading({ title }: { title: string }) {
  return (
    <Card aria-busy>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">Loading job…</p>
      </CardContent>
    </Card>
  );
}

/** `JobProgress` whose code is fetched when a job is first shown (error with Retry if that fails). */
export function LazyJobProgress({ jobId, title }: { jobId: string; title: string }) {
  return (
    <LazySection key={jobId} what="the job progress" loading={<JobProgressLoading title={title} />} compact>
      <JobProgressImpl jobId={jobId} title={title} />
    </LazySection>
  );
}
