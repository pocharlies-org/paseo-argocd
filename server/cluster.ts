import { execCommand } from "@getpaseo/plugin/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { DeployStatus } from "../shared/argocd.ts";

// The daemon reads the cluster with its own kubeconfig (the paseo pod reaches the API over the tailnet): no credential
// reaches the client. shortcut: <every Application lives in ns argocd (the root app-of-apps pattern)>, <upgrade if namespaced apps appear>.
const NS = "argocd";
// Base of the ArgoCD UI for the popover link: ARGOCD_UI, or the first line of ~/.config/paseo-argocd/ui; empty = no link.
const uiBase = (
  process.env.ARGOCD_UI ??
  (() => {
    try {
      return readFileSync(`${homedir()}/.config/paseo-argocd/ui`, "utf8").trim();
    } catch {
      return "";
    }
  })()
).replace(/\/+$/, "");
const env = { ...process.env, KUBECONFIG: process.env.KUBECONFIG ?? `${homedir()}/.kube/config` };

interface AppJson {
  spec: { source?: { repoURL?: string }; targetRevision?: string };
  status: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; startedAt?: string; finishedAt?: string };
    resources?: Array<{ kind?: string; name?: string; namespace?: string; status?: string; health?: { status?: string; message?: string } }>;
  };
}

export function parseApp(name: string, a: AppJson): DeployStatus {
  const op = a.status.operationState;
  const bad = (a.status.resources ?? []).filter(
    (r) => (r.health && r.health.status !== "Healthy") || (r.status && r.status !== "Synced"),
  );
  return {
    url: uiBase ? `${uiBase}/${name}` : "",
    sync: a.status.sync?.status ?? "Unknown",
    health: a.status.health?.status ?? "Unknown",
    operation: op?.phase ?? "",
    revision: a.status.sync?.revision ?? "",
    message: a.status.health?.message || op?.message || "",
    startedAt: op?.startedAt ?? null,
    completedAt: op && op.phase !== "Running" ? (op.finishedAt ?? null) : null,
    resources: bad.map((r) => ({
      key: `${r.kind}/${r.namespace ? `${r.namespace}/` : ""}${r.name}`,
      sync: r.status ?? "",
      health: r.health?.status ?? "",
      message: r.health?.message ?? "",
    })),
    error: null,
  };
}

const empty: DeployStatus = {
  url: "", sync: "Unknown", health: "Unknown", operation: "", revision: "", message: "",
  startedAt: null, completedAt: null, resources: [], error: null,
};

const TTL_GET_MS = 15_000;
const TTL_LIST_MS = 60_000;
const cacheGet = new Map<string, { at: number; value: Promise<DeployStatus> }>();
let listing: { at: number; value: Promise<Set<string>> } | null = null;

/** One read per app every 15 s, however many clients and agents ask. Failures come back as `error`, not thrown. */
export function readApp(app: string): Promise<DeployStatus> {
  const hit = cacheGet.get(app);
  if (hit && Date.now() - hit.at < TTL_GET_MS) return hit.value;
  for (const [k, v] of cacheGet) if (Date.now() - v.at >= TTL_GET_MS) cacheGet.delete(k);
  const value = execCommand("kubectl", ["get", "application", app, "-n", NS, "-o", "json"], { env, timeout: 20_000 })
    .then(({ stdout }) => parseApp(app, JSON.parse(stdout) as AppJson))
    .catch((e: Error): DeployStatus => ({ ...empty, error: String(e.message ?? e).slice(0, 300) }));
  cacheGet.set(app, { at: Date.now(), value });
  return value;
}

/** The cluster's app names. */
export function clusterIndex(): Promise<Set<string>> {
  if (listing && Date.now() - listing.at < TTL_LIST_MS) return listing.value;
  listing = {
    at: Date.now(),
    value: execCommand("kubectl", ["get", "applications", "-n", NS, "-o", "json"], { env, timeout: 30_000 })
      .then(({ stdout }) => new Set<string>(((JSON.parse(stdout).items ?? []) as Array<{ metadata: { name: string } }>).map((i) => i.metadata.name)))
      .catch(() => new Set<string>()),
  };
  return listing.value;
}
