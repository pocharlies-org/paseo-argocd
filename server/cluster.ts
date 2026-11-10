import { execCommand } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import type { DeployStatus } from "../shared/argocd.ts";

// The daemon reads the cluster with its own kubeconfig (the paseo pod reaches the API over the tailnet): no credential
// reaches the client. shortcut: <every Application lives in ns argocd (the root app-of-apps pattern)>, <upgrade if namespaced apps appear>.
const NS = "argocd";
const UI = "https://argocd.lan.e-dani.com/applications/argocd/";
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
    url: `${UI}${name}`,
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
let listing: { at: number; value: Promise<{ known: Set<string>; repoToApp: Map<string, string> }> } | null = null;

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

/** The cluster's app names and the repos that belong to exactly one app (a shared repo like dgx-infra maps to nothing). */
export function clusterIndex(): Promise<{ known: Set<string>; repoToApp: Map<string, string> }> {
  if (listing && Date.now() - listing.at < TTL_LIST_MS) return listing.value;
  listing = {
    at: Date.now(),
    value: execCommand("kubectl", ["get", "applications", "-n", NS, "-o", "json"], { env, timeout: 30_000 })
      .then(({ stdout }) => {
        const items = (JSON.parse(stdout).items ?? []) as Array<{ metadata: { name: string }; spec: { source?: { repoURL?: string } } }>;
        const known = new Set(items.map((i) => i.metadata.name));
        const byRepo = new Map<string, string | null>();
        for (const i of items) {
          const repo = (i.spec.source?.repoURL ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
          if (!repo) continue;
          const short = repo.split("/").pop()!;
          byRepo.set(short, byRepo.get(short) === undefined ? i.metadata.name : null); // null = several apps share it
        }
        const repoToApp = new Map([...byRepo].filter(([, v]) => v) as Array<[string, string]>);
        return { known, repoToApp };
      })
      .catch(() => ({ known: new Set<string>(), repoToApp: new Map<string, string>() })),
  };
  return listing.value;
}
