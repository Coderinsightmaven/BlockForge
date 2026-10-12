import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import type { SmtpConfig } from "../config/env.js";
import { safePostJson, type SafePostOptions } from "./http.js";

export interface NotificationMessage {
  status: "firing" | "resolved" | "test";
  severity: "info" | "warning" | "critical";
  title: string;
  text: string;
  at: number;
  fields?: { name: string; value: string }[];
  incidentId?: string | null;
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_PATH = /^\/api(\/v\d+)?\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]{1,100}$/;

/** Discord webhooks must be HTTPS URLs on Discord's own hosts (no arbitrary targets). */
export function validateDiscordUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("Discord webhook URLs must use https://");
  if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Discord webhook URLs must be on discord.com or discordapp.com");
  if (url.port && url.port !== "443") throw new Error("unexpected port in Discord webhook URL");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (!DISCORD_PATH.test(url.pathname)) throw new Error("not a Discord webhook URL (/api/webhooks/<id>/<token>)");
  return url;
}

export const EmailConfig = z.object({ to: z.array(z.email()).min(1).max(20) });

const COLORS = { critical: 0xdc2626, warning: 0xf59e0b, info: 0x3b82f6, resolved: 0x16a34a } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function discordPayload(m: NotificationMessage): unknown {
  return {
    username: "BlockForge",
    // Message text contains untrusted strings (server names, MOTDs…): never let them ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(`${m.status === "resolved" ? "Resolved" : m.status === "test" ? "Test" : m.severity.toUpperCase()}: ${m.title}`, 256),
        description: clip(m.text, 4000),
        color: m.status === "resolved" ? COLORS.resolved : COLORS[m.severity],
        timestamp: new Date(m.at).toISOString(),
        fields: (m.fields ?? []).slice(0, 10).map((f) => ({ name: clip(f.name, 256), value: clip(f.value || "-", 1024), inline: true })),
      },
    ],
  };
}

export function webhookPayload(m: NotificationMessage): unknown {
  return {
    source: "blockforge",
    status: m.status,
    severity: m.severity,
    title: m.title,
    text: m.text,
    at: m.at,
    incidentId: m.incidentId ?? null,
    fields: m.fields ?? [],
  };
}

export class EmailSender {
  private transporter: Transporter | null = null;

  constructor(private readonly smtp: SmtpConfig | null) {}

  get configured(): boolean {
    return this.smtp !== null;
  }

  async send(to: string[], m: NotificationMessage): Promise<void> {
    if (!this.smtp) throw new Error("SMTP is not configured on this control plane");
    this.transporter ??= nodemailer.createTransport({
      host: this.smtp.host,
      port: this.smtp.port,
      secure: this.smtp.secure,
      ...(this.smtp.user ? { auth: { user: this.smtp.user, pass: this.smtp.password ?? "" } } : {}),
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
    const prefix = m.status === "resolved" ? "RESOLVED" : m.status === "test" ? "TEST" : m.severity.toUpperCase();
    const fields = (m.fields ?? []).map((f) => `${f.name}: ${f.value}`).join("\n");
    await this.transporter.sendMail({
      from: this.smtp.from,
      to,
      subject: clip(`[BlockForge] ${prefix}: ${m.title}`.replace(/[\r\n]+/g, " "), 200),
      text: `${m.text}\n\n${fields}\n\n${new Date(m.at).toISOString()}`,
    });
  }
}

export async function sendDiscord(url: string, m: NotificationMessage, opts: SafePostOptions): Promise<void> {
  validateDiscordUrl(url);
  // Discord hosts are public; the allowlist does not apply.
  const { allowlist: _ignored, ...rest } = opts;
  await safePostJson(url, discordPayload(m), rest);
}

export async function sendWebhook(url: string, m: NotificationMessage, opts: SafePostOptions): Promise<void> {
  await safePostJson(url, webhookPayload(m), opts);
}
