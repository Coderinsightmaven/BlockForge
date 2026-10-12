import { Transform, type Readable, type TransformCallback } from "node:stream";

export type TransferDirection = "agent-upload" | "agent-download";

export class TransferError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "TIMEOUT" | "TOO_LARGE" | "ABORTED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

/** Counts bytes and fails the stream once `maxBytes` is exceeded (no buffering). */
export class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(new TransferError("TOO_LARGE", `transfer exceeds ${this.maxBytes} bytes`));
      return;
    }
    cb(null, chunk);
  }
}

interface Pending {
  id: string;
  nodeId: string;
  direction: TransferDirection;
  maxBytes: number;
  timer: NodeJS.Timeout;
  claimed: boolean;
  /** agent-upload: hands the agent's request stream to the waiting consumer. */
  deliver?: (stream: Readable) => void;
  /** agent-download: the stream offered to the agent. */
  source?: Readable;
  fail: (err: TransferError) => void;
  /** agent-download: resolves when the agent finished reading. */
  done?: (bytes: number) => void;
}

/**
 * Rendezvous between a control-plane producer/consumer (e.g. a browser upload/download request)
 * and an agent HTTP request (`POST|GET /agent/v1/transfers/:id`). Data is piped straight through
 * with backpressure — whole files are never buffered — and every transfer is bound to one node,
 * single-use, size-limited and expires if the counterpart does not arrive in time.
 */
export class TransferBroker {
  private readonly transfers = new Map<string, Pending>();

  constructor(private readonly defaultTimeoutMs = 60_000) {}

  private register(p: Omit<Pending, "timer" | "claimed">, timeoutMs: number): void {
    if (this.transfers.has(p.id)) throw new TransferError("CONFLICT", "transfer id already registered");
    const timer = setTimeout(() => {
      if (this.transfers.get(p.id) === entry && !entry.claimed) {
        this.transfers.delete(p.id);
        p.fail(new TransferError("TIMEOUT", "the agent did not connect to the transfer in time"));
      }
    }, timeoutMs);
    timer.unref();
    const entry: Pending = { ...p, timer, claimed: false };
    this.transfers.set(p.id, entry);
  }

  /**
   * Waits for the agent to upload (`fs.transfer.push`). Resolves with a byte-limited stream of the
   * agent's request body; the consumer must read it to completion (or destroy it).
   */
  expectUpload(spec: { id: string; nodeId: string; maxBytes: number; timeoutMs?: number }): Promise<Readable> {
    return new Promise<Readable>((resolve, reject) => {
      this.register(
        { id: spec.id, nodeId: spec.nodeId, direction: "agent-upload", maxBytes: spec.maxBytes, deliver: resolve, fail: reject },
        spec.timeoutMs ?? this.defaultTimeoutMs,
      );
    });
  }

  /** Offers `source` to the agent (`fs.transfer.pull`); resolves with the byte count once fully read. */
  offerDownload(spec: { id: string; nodeId: string; maxBytes: number; timeoutMs?: number }, source: Readable): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.register(
        {
          id: spec.id,
          nodeId: spec.nodeId,
          direction: "agent-download",
          maxBytes: spec.maxBytes,
          source,
          done: resolve,
          fail: (err) => {
            source.destroy();
            reject(err);
          },
        },
        spec.timeoutMs ?? this.defaultTimeoutMs,
      );
    });
  }

  cancel(id: string): void {
    const p = this.transfers.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.transfers.delete(id);
    p.fail(new TransferError("ABORTED", "transfer cancelled"));
  }

  /** Claims a transfer for the authenticated node. Unknown ids and other nodes' ids look identical. */
  private claim(id: string, nodeId: string, direction: TransferDirection): Pending {
    const p = this.transfers.get(id);
    if (!p || p.nodeId !== nodeId || p.direction !== direction || p.claimed) {
      throw new TransferError("NOT_FOUND", "transfer not found");
    }
    p.claimed = true;
    clearTimeout(p.timer);
    this.transfers.delete(id);
    return p;
  }

  /**
   * Agent POST: pipes the request body to the waiting consumer. Resolves with the byte count when
   * the body has been fully passed through.
   */
  acceptAgentUpload(id: string, nodeId: string, body: Readable): Promise<number> {
    const p = this.claim(id, nodeId, "agent-upload");
    const limiter = new ByteLimit(p.maxBytes);
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        body.destroy();
        limiter.destroy(err);
        reject(err instanceof TransferError ? err : new TransferError("ABORTED", err.message));
      };
      body.once("error", onError);
      limiter.once("error", onError);
      limiter.once("end", () => resolve(limiter.bytes));
      body.once("aborted", () => onError(new TransferError("ABORTED", "agent upload aborted")));
      body.pipe(limiter);
      p.deliver?.(limiter);
    });
  }

  /** Agent GET: returns the offered stream (byte-limited); the route pipes it into the response. */
  openAgentDownload(id: string, nodeId: string): Readable {
    const p = this.claim(id, nodeId, "agent-download");
    const source = p.source as Readable;
    const limiter = new ByteLimit(p.maxBytes);
    source.once("error", (err) => limiter.destroy(err));
    limiter.once("error", (err) => {
      source.destroy();
      p.fail(err instanceof TransferError ? err : new TransferError("ABORTED", err.message));
    });
    limiter.once("end", () => p.done?.(limiter.bytes));
    limiter.once("close", () => {
      if (!limiter.readableEnded) {
        source.destroy();
        p.fail(new TransferError("ABORTED", "agent download aborted"));
      }
    });
    return source.pipe(limiter);
  }

  get size(): number {
    return this.transfers.size;
  }
}
