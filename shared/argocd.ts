import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const NAME = "([a-z0-9](?:[-a-z0-9.]*[a-z0-9])?)";

// An ArgoCD app's name, or a Flux object as `ks|hr/<namespace>/<name>` (Kustomization, HelmRelease).
const appName = z.string().regex(/^(?:(?:ks|hr)\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);

/** Whether a key names a Flux object (`ks|hr/<namespace>/<name>`) rather than an ArgoCD app. */
export const isFlux = (key: string) => /^(ks|hr)\//.test(key);
/** What a pill calls it: the app, or the Flux object's own name. */
export const shortName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

export const deploySchema = z.object({
  motor: z.enum(["argocd", "flux"]),
  url: z.string(),
  panel: z.string(), // the platform's Kubernetes view for this app (empty = not configured)
  sync: z.string(), // ArgoCD: Synced | OutOfSync | Unknown. Flux: Ready | NotReady | Unknown (the Ready condition)
  health: z.string(), // ArgoCD: Healthy | Progressing | Degraded | Suspended | Missing | Unknown. Flux: Ready's reason, or Suspended
  operation: z.string(), // Running | Succeeded | Failed | Error | Terminated | "" (no operation yet)
  revision: z.string(),
  message: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  resources: z.array(z.object({ key: z.string(), sync: z.string(), health: z.string(), message: z.string() })),
  error: z.string().nullable(),
});
export type DeployStatus = z.output<typeof deploySchema>;

/**
 * The state of the asked apps, pushed and never polled (SC-5835): the daemon keeps one Kubernetes watch per resource
 * (Applications, Kustomizations, HelmReleases) and holds this call until one of the asked apps changes what a pill shows, or the hold expires (empty answer). `apps` holds
 * only the asked apps that changed after `since`; `completo` — a first call (`since: 0`) or a `since` from before the plugin
 * (re)started — brings every asked app. An app the cluster does not have comes with `error`.
 */
export const argocdWatch = defineRpc({
  name: "argocd.watch",
  input: z.object({ apps: z.array(appName), since: z.number().int() }).strict(),
  output: z.object({ version: z.number().int(), completo: z.boolean(), apps: z.record(z.string(), deploySchema) }),
});

/**
 * Each agent's ArgoCD app or Flux object (see lastKnown) and whether it is waiting on a deployment (see esperaArgocd),
 * resolved by the daemon against the cluster: the client never reads kubectl.
 */
export const argocdRefs = defineRpc({
  name: "argocd.refs",
  input: z.object({ agentIds: z.array(z.string()) }).strict(),
  output: z.object({ refs: z.record(z.string(), z.string().nullable()), esperas: z.record(z.string(), z.boolean()) }),
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

// Flux, in one command: `flux reconcile|get|suspend|resume|diff|tree kustomization|ks|helmrelease|hr <name>` or
// `kubectl get|describe|wait kustomization|ks|helmrelease|hr[.<group>] <name>`, with `-n|--namespace <ns>` anywhere in it
// (flux-system when absent, as the flux CLI does).
const FLUX_PATTERN = new RegExp(
  `\\b(?:flux\\s+(?:reconcile|get|suspend|resume|diff|tree)|kubectl\\b[^"\\n|;&]*?\\b(?:get|describe|wait))\\s+` +
    `(kustomizations?|ks|helmreleases?|hr)(?:\\.[a-z.]+)?[\\s/]+${NAME}\\b[^"\\n|;&]*`,
  "g",
);
const FLUX_NS = /(?:^|\s)(?:-n|--namespace)[\s=]([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\b/;

/** Every app or Flux object the text names, with its position. */
export function mentions(text: string): Array<{ at: number; app: string }> {
  const out: Array<{ at: number; app: string }> = [];
  for (const re of APP_PATTERNS) for (const m of text.matchAll(re)) out.push({ at: m.index!, app: m[1] });
  for (const m of text.matchAll(FLUX_PATTERN)) {
    const kind = m[1]!.startsWith("h") ? "hr" : "ks";
    out.push({ at: m.index!, app: `${kind}/${FLUX_NS.exec(m[0])?.[1] ?? "flux-system"}/${m[2]}` });
  }
  return out;
}

/** The last app the text names, without checking it exists (live timeline events have no cluster knowledge). */
export function lastMention(text: string): string | null {
  let best: { at: number; app: string } | null = null;
  for (const m of mentions(text)) if (!best || m.at >= best.at) best = m;
  return best?.app ?? null;
}

/**
 * The ArgoCD app or Flux object some mentions point at: the last one that exists in the cluster (the daemon keeps each agent's mentions
 * and re-checks them). A repo name alone is not a mention: the pill is only for what the session waits on or deploys,
 * never for what it merely reads.
 * shortcut: <apps live in ns argocd and one app per agent (the last named)>, <upgrade if agents need to watch several apps>.
 */
export function lastKnown(found: ReadonlyArray<{ at: number; app: string }>, known: ReadonlySet<string>): string | null {
  let best: { at: number; app: string } | null = null;
  for (const m of found) {
    if (known.has(m.app) && (!best || m.at >= best.at)) best = m;
  }
  return best?.app ?? null;
}

/**
 * The text a session itself wrote or ran: user and assistant messages and shell commands. Tool results (the text of a
 * skill, the output of kubectl), reasoning and notifications are never scanned: they name apps the session is not
 * deploying. Structural type on purpose — shared is also loaded by the client.
 */
export function agentText(item: { type: string; text?: string; detail?: { type?: string; command?: string } } | null | undefined): string {
  if (!item) return "";
  if (item.type === "user_message" || item.type === "assistant_message") return item.text ?? "";
  if (item.type === "tool_call") return item.detail?.type === "shell" ? item.detail.command ?? "" : "";
  return "";
}

// The kind of `ESPERA:` the supervisor wakes with an ArgoCD event (skill pr-watcher): while the session's last own word
// is one, its pill turns — Dani sees at a glance that the wait is on the deployment and not on GitHub (25-11).
export const ESPERA_ARGOCD = /ESPERA:\s*argocd\b/;

/** Whether the session's last own word is an ArgoCD-side ESPERA: walk its timeline items oldest first (the client folds one at a time). */
export function esperaArgocd(items: ReadonlyArray<{ type?: string; text?: string }>): boolean {
  let waiting = false;
  for (const it of items) {
    if (it.type === "user_message") waiting = false; // a new turn started: the wait is over until its final message says otherwise
    else if (it.type === "assistant_message") waiting = ESPERA_ARGOCD.test(it.text ?? "");
  }
  return waiting;
}

export type DeployState = "pending" | "failure" | "success" | "none";
export function deployState(d: { motor: string; sync: string; health: string; operation: string }): DeployState {
  if (d.motor === "flux") {
    if (d.health === "Suspended") return "none";
    if (d.sync === "NotReady") return "failure";
    return d.sync === "Unknown" || d.operation === "Running" ? "pending" : "success";
  }
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

/**
 * The pill's label: the app, the state glyph and BOTH axes — `paseo ✓ Synced·Healthy`, `paseo ◐ Synced·Progressing`,
 * `paseo ✗ Synced·Degraded`, `paseo · OutOfSync·Healthy` (at rest), `paseo ?` (unreadable). The glyph and its colour
 * say good/bad/pending; the words say which of the two axes is which, so a glance answers "está todo bien".
 * ArgoCD's own words, as `kubectl get application` and the panel show them (the popover is where they read in Spanish).
 */
export function pillLabel(key: string, d: DeployStatus | null): string {
  const app = shortName(key);
  if (!d) return app;
  if (d.error) return `${app} ?`;
  // Flux's words, as `flux get` shows them: Ready, or the reason it is not (HealthCheckFailed, Progressing, Suspended…).
  if (d.motor === "flux") return `${app} ${GLYPH[deployState(d)]} ${d.sync === "Ready" && d.health !== "Suspended" ? "Ready" : d.health}`;
  return `${app} ${GLYPH[deployState(d)]} ${d.sync}·${d.health}`;
}
