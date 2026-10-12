import {
  ArtifactPlan,
  type ArtifactPlan as ArtifactPlanT,
  type ServerSoftware,
  type SoftwareBuild,
  type SoftwareInfo,
  type SoftwareVersion,
} from "@blockforge/contracts";
import { CATALOG_HOSTS, CatalogError, createCatalog, TtlCache, type Catalog, type CatalogContext } from "@blockforge/minecraft";
import type { Logger } from "pino";
import { AppError, badRequest, notFound, upstreamError } from "../lib/errors.js";
import type { LookupFn } from "../notifications/ssrf.js";
import { createSafeFetch, SafeFetchError } from "./safe-fetch.js";

export interface CatalogServiceOptions {
  logger: Logger;
  /** Adapter overrides (tests). */
  catalog?: Partial<Catalog>;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  ttlMs?: number;
}

/** Hosts the catalogue may contact: every metadata/artifact host the adapters (and the URLs inside their JSON) use. */
export const CATALOG_ALLOWED_HOSTS: readonly string[] = [...new Set([...CATALOG_HOSTS.metadata, ...CATALOG_HOSTS.artifacts])];

/**
 * Server software catalogue (`@blockforge/minecraft` adapters) behind an SSRF-safe fetch and a TTL
 * cache. Upstream failures map to 502 UPSTREAM_ERROR; unknown versions/builds to 404.
 */
export class CatalogService {
  private readonly catalog: Catalog;
  private readonly ctx: CatalogContext;

  constructor(private readonly opts: CatalogServiceOptions) {
    this.catalog = { ...createCatalog(), ...(opts.catalog ?? {}) } as Catalog;
    this.ctx = {
      fetch: createSafeFetch({
        allowedHosts: CATALOG_ALLOWED_HOSTS,
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        timeoutMs: 15_000,
        maxBytes: 16 * 1024 * 1024,
      }),
      cache: new TtlCache<string, string>({ defaultTtlMs: opts.ttlMs ?? 10 * 60_000, maxEntries: 500 }),
      ttlMs: opts.ttlMs ?? 10 * 60_000,
    };
  }

  private adapter(software: ServerSoftware) {
    const a = this.catalog[software];
    if (!a) throw notFound("Software");
    return a;
  }

  private mapError(err: unknown): unknown {
    if (err instanceof AppError) return err;
    if (err instanceof SafeFetchError) {
      this.opts.logger.warn({ err: err.message }, "catalogue fetch refused");
      return upstreamError("Catalogue request refused by the outbound policy");
    }
    if (err instanceof CatalogError) {
      switch (err.code) {
        case "NOT_FOUND":
          return notFound("Version or build");
        case "INVALID_ARGUMENT":
          return badRequest(err.message);
        case "UNAVAILABLE":
        case "UNSUPPORTED":
          return new AppError(422, "PRECONDITION_FAILED", err.message);
        default:
          this.opts.logger.warn({ code: err.code, msg: err.message }, "catalogue upstream error");
          return upstreamError("The software catalogue upstream is unavailable or returned unexpected data");
      }
    }
    return err;
  }

  info(): SoftwareInfo[] {
    return Object.values(this.catalog).map((a) => a.info);
  }

  async versions(software: ServerSoftware): Promise<SoftwareVersion[]> {
    try {
      const list = await this.adapter(software).listVersions(this.ctx);
      return list.map((v) => ({
        minecraftVersion: v.minecraftVersion,
        channel: v.channel,
        javaMajor: v.javaMajor,
        releasedAt: v.releasedAt,
        javaSource: v.javaSource,
        support: v.support,
        notes: v.notes,
      }));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async builds(software: ServerSoftware, version: string): Promise<SoftwareBuild[]> {
    try {
      return await this.adapter(software).listBuilds(this.ctx, version);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** `build` = null or "latest" resolves the newest stable build. */
  async plan(software: ServerSoftware, version: string, build: string | null): Promise<ArtifactPlanT> {
    try {
      const resolved = await this.adapter(software).resolve(this.ctx, version, build === "latest" ? null : build);
      const parsed = ArtifactPlan.safeParse(resolved);
      if (!parsed.success) throw new CatalogError("INVALID_UPSTREAM_RESPONSE", "resolved artifact does not match the ArtifactPlan contract");
      return parsed.data;
    } catch (err) {
      throw this.mapError(err);
    }
  }
}
