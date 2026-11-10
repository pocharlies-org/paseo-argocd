import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const NAME = "([a-z0-9](?:[-a-z0-9.]*[a-z0-9])?)";

export const appRefSchema = z.object({ app: z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/) });
export type AppRef = z.output<typeof appRefSchema>;

export const deploySchema = z.object({
  url: z.string(),
  sync: z.string(), // Synced | OutOfSync | Unknown
  health: z.string(), // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
  operation: z.string(), // Running | Succeeded | Failed | Error | Terminated | "" (no operation yet)
  revision: z.string(),
  message: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  resources: z.array(z.object({ key: z.string(), sync: z.string(), health: z.string(), message: z.string() })),
  error: z.string().nullable(),
});
export type DeployStatus = z.output<typeof deploySchema>;

/** The live state of one ArgoCD application, read by the daemon with its own kubeconfig. */
export const argocdGet = defineRpc({ name: "argocd.get", input: appRefSchema.strict(), output: deploySchema });

/** Each agent's ArgoCD app (see lastAppRef), resolved by the daemon against the cluster: the client never reads kubectl. */
export const argocdRefs = defineRpc({
  name: "argocd.refs",
  input: z.object({ agentIds: z.array(z.string()) }).strict(),
  output: z.object({ refs: z.record(z.string(), z.string().nullable()) }),
});

// A session names its app when it deploys or watches it: `argocd app sync paseo`, `ESPERA: argocd paseo`,
// `kubectl [get|describe|wait] application(s) paseo … argocd` (either argument order), or the UI link.
const APP_PATTERNS: RegExp[] = [
  new RegExp(`argocd app (?:sync|get|wait|diff|rollback|delete) ${NAME}\\b`, "g"),
  new RegExp(`ESPERA:\\s*argocd ${NAME}\\b`, "g"),
  new RegExp(`kubectl[^"\\n]*?\\b(?:get|describe|wait) (?:applications?|apps?) ${NAME}\\b[^"\\n]*?argocd`, "g"),
  new RegExp(`kubectl[^"\\n]*?argocd[^"\\n]*?\\b(?:get|describe|wait) (?:applications?|apps?) ${NAME}\\b`, "g"),
  new RegExp(`/applications/argocd/${NAME}\\b`, "g"),
];

/** Every app the text names, with its position. */
export function mentions(text: string): Array<{ at: number; app: string }> {
  const out: Array<{ at: number; app: string }> = [];
  for (const re of APP_PATTERNS) for (const m of text.matchAll(re)) out.push({ at: m.index!, app: m[1] });
  return out;
}

/** The last app the text names, without checking it exists (live timeline events have no cluster knowledge). */
export function lastMention(text: string): string | null {
  let best: { at: number; app: string } | null = null;
  for (const m of mentions(text)) if (!best || m.at >= best.at) best = m;
  return best?.app ?? null;
}

/**
 * The ArgoCD app a piece of text points at: its last mention that exists in the cluster; if none names an app, the
 * last mention of a deploy repo that belongs to exactly one app (`k8s-paseo-pocharlies` → `paseo`).
 * shortcut: <apps live in ns argocd and one app per agent (the last named); repos shared by several apps (dgx-infra)
 * are not mapped>, <upgrade if agents need to watch several apps>.
 */
export function lastAppRef(text: string, known: ReadonlySet<string>, repoToApp: ReadonlyMap<string, string>): string | null {
  let best: { at: number; app: string } | null = null;
  for (const m of mentions(text)) {
    if (known.has(m.app) && (!best || m.at >= best.at)) best = m;
  }
  if (best) return best.app;
  for (const [repo, app] of repoToApp) {
    const at = text.lastIndexOf(repo);
    if (at >= 0 && (!best || at > best.at)) best = { at, app };
  }
  return best?.app ?? null;
}

export type DeployState = "pending" | "failure" | "success" | "none";
export function deployState(d: { sync: string; health: string; operation: string }): DeployState {
  if (d.health === "Degraded" || d.operation === "Failed" || d.operation === "Error" || d.operation === "Terminated")
    return "failure";
  if (d.operation === "Running" || d.health === "Progressing" || d.sync === "Unknown") return "pending";
  if (d.sync === "Synced" && d.health === "Healthy") return "success";
  return "none"; // OutOfSync at rest, Suspended, Missing: not deploying
}

/** The pill's colour: yellow while it syncs or rolls out, red degraded, green Synced+Healthy; none when unknown. */
export type Tone = "pending" | "failure" | "success" | null;
export function tone(d: DeployStatus | null): Tone {
  if (!d || d.error) return null;
  const s = deployState(d);
  return s === "none" ? null : s;
}

export const GLYPH: Record<DeployState, string> = { success: "✓", failure: "✗", pending: "◐", none: "·" };

/** The pill's short label: `paseo ◐`, `paseo ✓`, `paseo ✗`, `paseo ·` (OutOfSync at rest), `paseo ?` (unreadable). */
export function pillLabel(app: string, d: DeployStatus | null): string {
  if (!d) return app;
  if (d.error) return `${app} ?`;
  const s = deployState(d);
  if (s === "none") return `${app} ${GLYPH.none} ${d.sync === "OutOfSync" ? "out" : d.health.toLowerCase()}`;
  return `${app} ${GLYPH[s]}`;
}
