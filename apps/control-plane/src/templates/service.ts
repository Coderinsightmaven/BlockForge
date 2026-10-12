import { randomUUID } from "node:crypto";
import {
  RESERVED_ENV_VARS,
  type Template,
  type TemplateImportPreview,
  type TemplateSummary,
  type TemplateVariable,
  type UpdateTemplateRequest,
} from "@blockforge/contracts";
import { DEFAULT_AGENT_IMAGE_ALLOWLIST, exportEgg, isValidImageRef, parseEgg } from "@blockforge/eggs";
import { asc, count, eq, inArray, like } from "drizzle-orm";
import type { z } from "zod";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db, DbOrTx } from "../db/client.js";
import { servers, templates, templateVariables } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { Clock } from "../lib/clock.js";
import { AppError, badRequest, conflict, notFound, validationDetails } from "../lib/errors.js";

type TemplateRow = typeof templates.$inferSelect;
type VariableRow = typeof templateVariables.$inferSelect;
type UpdateInput = z.infer<typeof UpdateTemplateRequest>;
type ImportedTemplate = NonNullable<TemplateImportPreview["template"]>;

const RESERVED = new Set<string>(RESERVED_ENV_VARS);
/** Fields of built-in templates that administrators may change. */
const BUILTIN_EDITABLE = new Set(["name", "description", "category"]);

export interface ImportInput {
  egg: Record<string, unknown>;
  category: string;
  game?: Template["game"] | undefined;
  replaceKey?: string | undefined;
}

function variableDto(v: VariableRow): TemplateVariable {
  return {
    envName: v.envName,
    name: v.name,
    description: v.description,
    defaultValue: v.defaultValue,
    userViewable: v.userViewable,
    userEditable: v.userEditable,
    rules: v.rules,
    sortOrder: v.sortOrder,
  };
}

export class TemplatesService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly imageAllowlist: readonly string[] = DEFAULT_AGENT_IMAGE_ALLOWLIST,
  ) {}

  private async variablesFor(ids: string[], tx: DbOrTx = this.db): Promise<Map<string, TemplateVariable[]>> {
    const out = new Map<string, TemplateVariable[]>();
    if (!ids.length) return out;
    const rows = await tx
      .select()
      .from(templateVariables)
      .where(inArray(templateVariables.templateId, ids))
      .orderBy(asc(templateVariables.sortOrder), asc(templateVariables.envName));
    for (const r of rows) {
      const list = out.get(r.templateId) ?? [];
      list.push(variableDto(r));
      out.set(r.templateId, list);
    }
    return out;
  }

  private async serverCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.db.select({ id: servers.templateId, n: count() }).from(servers).where(inArray(servers.templateId, ids)).groupBy(servers.templateId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  toDto(row: TemplateRow, variables: TemplateVariable[], serverCount: number): Template {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      category: row.category,
      kind: row.kind as Template["kind"],
      game: row.game as Template["game"],
      author: row.author,
      source: row.source as Template["source"],
      sourceFormat: (row.sourceFormat as Template["sourceFormat"]) ?? null,
      dockerImages: row.dockerImages,
      startup: row.startup,
      variables,
      configFiles: row.configFiles,
      startupDone: row.startupDone,
      stop: row.stop,
      install: row.install ?? null,
      features: row.features,
      fileDenylist: row.fileDenylist,
      runtime: row.runtime,
      serverCount,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }

  async list(): Promise<Template[]> {
    const rows = await this.db.select().from(templates).orderBy(asc(templates.category), asc(templates.name));
    const ids = rows.map((r) => r.id);
    const [vars, counts] = await Promise.all([this.variablesFor(ids), this.serverCounts(ids)]);
    return rows.map((r) => this.toDto(r, vars.get(r.id) ?? [], counts.get(r.id) ?? 0));
  }

  /** What server creators see: no install script or config rules, only user-viewable variables. */
  async listSummaries(): Promise<TemplateSummary[]> {
    return (await this.list()).map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      kind: t.kind,
      game: t.game,
      dockerImages: t.dockerImages,
      features: t.features,
      serverCount: t.serverCount,
      variables: t.variables.filter((v) => v.userViewable),
    }));
  }

  async row(id: string, tx: DbOrTx = this.db): Promise<TemplateRow> {
    const [row] = await tx.select().from(templates).where(eq(templates.id, id)).limit(1);
    if (!row) throw notFound("Template");
    return row;
  }

  async get(id: string, tx: DbOrTx = this.db): Promise<Template> {
    const row = await this.row(id, tx);
    const vars = await this.variablesFor([id], tx);
    const counts = await this.serverCounts([id]);
    return this.toDto(row, vars.get(id) ?? [], counts.get(id) ?? 0);
  }

  preview(input: ImportInput): TemplateImportPreview {
    return parseEgg(input.egg, { category: input.category, ...(input.game ? { game: input.game } : {}), imageAllowlist: this.imageAllowlist });
  }

  private async freeKey(base: string, tx: DbOrTx): Promise<string> {
    const taken = new Set((await tx.select({ key: templates.key }).from(templates).where(like(templates.key, `${base}%`))).map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const suffix = `-${i}`;
      const k = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!taken.has(k)) return k;
    }
  }

  private async writeVariables(tx: DbOrTx, templateId: string, vars: readonly TemplateVariable[]): Promise<void> {
    await tx.delete(templateVariables).where(eq(templateVariables.templateId, templateId));
    if (vars.length) {
      await tx.insert(templateVariables).values(
        vars.map((v, i) => ({
          id: randomUUID(),
          templateId,
          envName: v.envName,
          name: v.name,
          description: v.description,
          defaultValue: v.defaultValue,
          userViewable: v.userViewable,
          userEditable: v.userEditable,
          rules: v.rules,
          sortOrder: v.sortOrder ?? i,
        })),
      );
    }
  }

  async import(input: ImportInput, actor: AuditActor): Promise<{ template: Template; issues: TemplateImportPreview["issues"] }> {
    const preview = this.preview(input);
    if (!preview.template) {
      throw new AppError(400, "VALIDATION_FAILED", "The egg could not be imported", {
        issues: preview.issues.filter((i) => i.severity === "error").map((i) => ({ path: i.path ?? "", message: `${i.code}: ${i.message}` })),
      });
    }
    const t: ImportedTemplate = preview.template;
    const id = await withTransaction(this.db, async (tx) => {
      let templateId: string;
      if (input.replaceKey) {
        const [existing] = await tx.select().from(templates).where(eq(templates.key, input.replaceKey)).for("update").limit(1);
        if (!existing) throw notFound("Template to replace");
        if (existing.source !== "import") throw badRequest("Built-in templates cannot be replaced by an egg");
        templateId = existing.id;
        await tx.update(templates).set({ ...this.columns(t), key: existing.key, rawImport: input.egg, updatedAt: new Date(this.clock.now()) }).where(eq(templates.id, templateId));
      } else {
        templateId = randomUUID();
        await tx.insert(templates).values({ id: templateId, ...this.columns(t), key: await this.freeKey(t.key, tx), rawImport: input.egg });
      }
      await this.writeVariables(tx, templateId, t.variables);
      await this.audit.record(
        {
          ...actor,
          action: input.replaceKey ? "template.replace" : "template.import",
          targetType: "template",
          targetId: templateId,
          outcome: "success",
          details: { name: t.name, sourceFormat: t.sourceFormat, images: t.dockerImages.map((i) => i.image), installImage: t.install?.image ?? null },
        },
        tx,
      );
      return templateId;
    });
    return { template: await this.get(id), issues: preview.issues };
  }

  private columns(t: ImportedTemplate): Omit<typeof templates.$inferInsert, "id"> {
    return {
      key: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      kind: "egg",
      game: t.game,
      author: t.author,
      source: "import",
      sourceFormat: t.sourceFormat,
      dockerImages: t.dockerImages,
      startup: t.startup,
      configFiles: t.configFiles,
      startupDone: t.startupDone,
      stop: t.stop,
      install: t.install,
      features: t.features,
      fileDenylist: t.fileDenylist,
      runtime: t.runtime,
    };
  }

  private validateUpdate(input: UpdateInput): void {
    if (input.variables) {
      const seen = new Set<string>();
      for (const [i, v] of input.variables.entries()) {
        if (RESERVED.has(v.envName)) throw badRequest(`${v.envName} is set by the platform`, validationDetails("reserved variable name", `variables.${i}.envName`));
        if (seen.has(v.envName)) throw badRequest(`Duplicate variable ${v.envName}`, validationDetails("duplicate", `variables.${i}.envName`));
        seen.add(v.envName);
      }
    }
    if (input.dockerImages) {
      for (const [i, im] of input.dockerImages.entries()) {
        if (!isValidImageRef(im.image)) throw badRequest(`Invalid image reference ${im.image}`, validationDetails("invalid image reference", `dockerImages.${i}.image`));
      }
    }
    if (input.install && !isValidImageRef(input.install.image)) throw badRequest("Invalid install image", validationDetails("invalid image reference", "install.image"));
  }

  async update(id: string, input: UpdateInput, actor: AuditActor): Promise<Template> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select().from(templates).where(eq(templates.id, id)).for("update").limit(1);
      if (!row) throw notFound("Template");
      const fields = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      if (row.source === "builtin") {
        const bad = fields.filter((f) => !BUILTIN_EDITABLE.has(f));
        if (bad.length) throw badRequest(`Built-in templates only allow changing name, description and category (not ${bad.join(", ")})`);
      }
      this.validateUpdate(input);
      const { variables, ...rest } = input;
      const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      await tx.update(templates).set({ ...set, updatedAt: new Date(this.clock.now()) }).where(eq(templates.id, id));
      if (variables) await this.writeVariables(tx, id, variables);
      await this.audit.record({ ...actor, action: "template.update", targetType: "template", targetId: id, outcome: "success", details: { fields } }, tx);
    });
    return this.get(id);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.select().from(templates).where(eq(templates.id, id)).for("update").limit(1);
      if (!row) throw notFound("Template");
      if (row.source === "builtin") throw badRequest("Built-in templates cannot be deleted");
      const [used] = await tx.select({ n: count() }).from(servers).where(eq(servers.templateId, id));
      if (Number(used?.n ?? 0) > 0) throw conflict("Servers still use this template");
      await tx.delete(templates).where(eq(templates.id, id));
      await this.audit.record({ ...actor, action: "template.delete", targetType: "template", targetId: id, outcome: "success", details: { name: row.name } }, tx);
    });
  }

  async export(id: string): Promise<Record<string, unknown>> {
    const t = await this.get(id);
    if (t.source === "builtin") throw badRequest("Built-in templates are catalogue-driven and cannot be exported as eggs");
    return exportEgg(t, { exportedAt: new Date(this.clock.now()) });
  }
}
