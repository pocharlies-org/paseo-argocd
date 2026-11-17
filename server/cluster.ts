import { spawnProcess } from "@getpaseo/plugin/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
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
// Base of the platform (Control Nexus) for the popover's primary link: PASEO_ARGOCD_PANEL, or the first line of
// ~/.config/paseo-argocd/panel; empty = no panel link (the ArgoCD UI link alone).
const panelBase = (
  process.env.PASEO_ARGOCD_PANEL ??
  (() => {
    try {
      return readFileSync(`${homedir()}/.config/paseo-argocd/panel`, "utf8").trim();
    } catch {
      return "";
    }
  })()
).replace(/\/+$/, "");
const env = { ...process.env, KUBECONFIG: process.env.KUBECONFIG ?? `${homedir()}/.kube/config` };

interface AppJson {
  metadata?: { name?: string; resourceVersion?: string; annotations?: Record<string, string> };
  spec: { source?: { repoURL?: string }; targetRevision?: string };
  // Absent on an Application ArgoCD has not reconciled yet: the watch's ADDED event for a new app (SC-5922).
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; startedAt?: string; finishedAt?: string };
    resources?: Array<{ kind?: string; name?: string; namespace?: string; status?: string; health?: { status?: string; message?: string } }>;
  };
}

export function parseApp(name: string, a: AppJson): DeployStatus {
  const st = a.status ?? {};
  const op = st.operationState;
  const bad = (st.resources ?? []).filter(
    (r) => (r.health && r.health.status !== "Healthy") || (r.status && r.status !== "Synced"),
  );
  return {
    motor: "argocd",
    url: uiBase ? `${uiBase}/${name}` : "",
    panel: panelBase ? `${panelBase}/services?mode=argocd&app=${name}` : "",
    sync: st.sync?.status ?? "Unknown",
    health: st.health?.status ?? "Unknown",
    operation: op?.phase ?? "",
    revision: st.sync?.revision ?? "",
    message: st.health?.message || op?.message || "",
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

interface FluxJson {
  metadata?: { name?: string; namespace?: string; resourceVersion?: string; annotations?: Record<string, string> };
  spec?: { suspend?: boolean };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    lastAppliedRevision?: string; // Kustomization: `main@sha1:<sha>`
    history?: Array<{ chartVersion?: string }>; // HelmRelease v2: the newest release first
  };
}

/** A Flux Kustomization or HelmRelease in the pill's words: Ready or not, with Flux's own reason and message. */
export function parseFlux(f: FluxJson): DeployStatus {
  const cond = (type: string) => f.status?.conditions?.find((c) => c.type === type);
  const ready = cond("Ready");
  const rev = f.status?.lastAppliedRevision ?? f.status?.history?.[0]?.chartVersion ?? "";
  const sha = /sha1:([0-9a-f]+)$/.exec(rev)?.[1];
  return {
    ...empty,
    motor: "flux",
    sync: ready?.status === "True" ? "Ready" : ready?.status === "False" ? "NotReady" : "Unknown",
    health: f.spec?.suspend ? "Suspended" : (ready?.reason ?? "Unknown"),
    operation: cond("Reconciling")?.status === "True" ? "Running" : "",
    revision: sha ? sha.slice(0, 7) : rev,
    message: ready?.message ?? "",
  };
}

const empty: DeployStatus = {
  motor: "argocd", url: "", panel: "", sync: "Unknown", health: "Unknown", operation: "", revision: "", message: "",
  startedAt: null, completedAt: null, resources: [], error: null,
};

/**
 * What the daemon watches: ArgoCD's Applications and Flux's two ways of deploying a repo, Kustomizations and HelmReleases.
 * The key is what a pill asks for: the app's name for ArgoCD, `ks|hr/<namespace>/<name>` for Flux (shared `isFlux` and `shortName` read it).
 */
type Obj = AppJson & FluxJson;
export interface Kind {
  path: string;
  key(o: Obj): string | undefined;
  parse(key: string, o: Obj): DeployStatus;
}
const fluxKind = (kind: "ks" | "hr", path: string): Kind => ({
  path,
  key: (o) => (o.metadata?.name && o.metadata.namespace ? `${kind}/${o.metadata.namespace}/${o.metadata.name}` : undefined),
  parse: (_key, o) => parseFlux(o),
});
export const KINDS: Record<string, Kind> = {
  app: { path: `/apis/argoproj.io/v1alpha1/namespaces/${NS}/applications`, key: (o) => o.metadata?.name, parse: (key, o) => parseApp(key, o) },
  ks: fluxKind("ks", "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations"),
  hr: fluxKind("hr", "/apis/helm.toolkit.fluxcd.io/v2/helmreleases"),
};
const kindOf = (key: string) => (key.startsWith("ks/") ? "ks" : key.startsWith("hr/") ? "hr" : "app");

const HOLD_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout
const RETRY_MAX_MS = 30_000;

/** One watch request on a resource: each line of the stream to `line`, then `closed` once with why it ended. Returns its stop. */
export type OpenWatch = (path: string, query: string, line: (text: string) => void, closed: (why: string) => void) => () => void;

const openKubectl: OpenWatch = (path, query, line, closed) => {
  const child = spawnProcess("kubectl", ["get", "--raw", `${path}?${query}`], { env, stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-300)));
  child.on("error", (e) => (stderr ||= e.message)); // kubectl missing: "close" still follows
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line);
  child.on("close", (code) => closed(stderr.trim() || `kubectl salió con ${code}`));
  return () => void child.kill();
};

export interface WatchAnswer {
  version: number;
  completo: boolean;
  apps: Record<string, DeployStatus>;
}

export interface AppWatch {
  /** The asked apps that changed after `since`: at once when there are some, else when one changes or the hold expires. */
  espera(apps: readonly string[], since: number): Promise<WatchAnswer>;
  /** The cluster's app names, once the first list arrived (or the watch could not start). */
  index(): Promise<Set<string>>;
  cierra(): void;
}

/**
 * ArgoCD and Flux push to nobody, so the plugin's server holds the one edge (SC-5835): one Kubernetes watch per resource
 * (`kubectl get --raw …?watch=1`), however many clients and agents. The first request of each streams every object and ends
 * its initial events with a bookmark; a closed stream resumes from the last resourceVersion, and an expired one (410) lists
 * again and drops what did not come back. Only what a pill shows counts as a change: both rewrite their objects on every
 * reconcile, and those writes wake nobody. A resource the cluster does not serve (no Flux, or Flux without helm-controller)
 * is simply absent: no retry, and its keys answer that the motor is not there.
 * shortcut: <while a watch is down the last state stays on the pills>, <mark them stale if outages turn out to last>.
 */
export function appWatch(open: OpenWatch = openKubectl, holdMs = HOLD_MS, kinds: Record<string, Kind> = KINDS): AppWatch {
  // A `since` from before this instance (the plugin was reloaded) is older than its start: that caller gets everything again.
  const start = Date.now();
  let version = start;
  const shown = new Map<string, { status: DeployStatus; key: string; at: number }>();
  const waiting = new Set<() => void>();
  const down = new Map<string, string>(); // why each resource's watch is not streaming, while it is not
  const absent = new Set<string>(); // resources this cluster does not serve
  const stops = new Map<string, () => void>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  // Callers wait until every resource has listed, or failed to start: a half index would drop an agent's app.
  const pending = new Set(Object.keys(kinds));
  let allListed!: () => void;
  const ready = new Promise<void>((r) => (allListed = r));
  const listed = (kind: string) => pending.delete(kind) && pending.size === 0 && allListed();

  const put = (name: string, status: DeployStatus) => {
    const key = JSON.stringify(status);
    if (shown.get(name)?.key === key) return;
    shown.set(name, { status, key, at: ++version });
    for (const wake of [...waiting]) wake();
  };
  const missing = (name: string): DeployStatus => {
    const kind = kindOf(name);
    const flux = kind !== "app";
    const error =
      down.get(kind) ??
      (absent.has(kind)
        ? `${flux ? "Flux" : "ArgoCD"} no está en este clúster`
        : `${name} no existe en ${flux ? "Flux" : `ArgoCD (${NS})`}`);
    return { ...empty, motor: flux ? "flux" : "argocd", error };
  };

  const connect = (kind: string, resume: string | null, failures: number) => {
    if (closed) return;
    const { path, key: keyOf, parse } = kinds[kind]!;
    const seen = new Set<string>();
    let everListed = false;
    const from = resume
      ? `&resourceVersion=${encodeURIComponent(resume)}`
      : "&sendInitialEvents=true&resourceVersionMatch=NotOlderThan";
    // One bad event must not end the watch: a throw here leaves the readline handler and kills the plugin process, which
    // the daemon never restarts — every later call then times out (SC-5922).
    const onLine = (text: string) => {
      let event: { type?: string; object?: Obj & { code?: number; message?: string } };
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      const o = event.object ?? ({} as NonNullable<typeof event.object>);
      if (event.type === "ERROR") {
        if (o.code === 410) resume = null; // too old to resume: list again on the next connect
        down.set(kind, o.message ?? "error del watch");
        return;
      }
      failures = 0;
      down.delete(kind);
      if (o.metadata?.resourceVersion) resume = o.metadata.resourceVersion;
      const name = keyOf(o);
      if ((event.type === "ADDED" || event.type === "MODIFIED") && name) {
        seen.add(name);
        put(name, parse(name, o));
      } else if (event.type === "DELETED" && name) put(name, missing(name));
      else if (event.type === "BOOKMARK" && o.metadata?.annotations?.["k8s.io/initial-events-end"] === "true") {
        // deleted while the watch was away
        for (const old of [...shown.keys()]) if (kindOf(old) === kind && !seen.has(old)) put(old, missing(old));
        everListed = true;
        listed(kind);
      }
    };
    stops.set(kind, open(path, `watch=1&allowWatchBookmarks=true${from}`, (text) => {
      try {
        onLine(text);
      } catch (e) {
        console.error(`paseo-argocd: evento del watch descartado: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, (why) => {
      if (closed) return;
      if (!everListed && !resume && /NotFound|could not find the requested resource/.test(why)) {
        absent.add(kind); // this cluster does not serve it: nothing to watch, nothing to retry
        listed(kind);
        return;
      }
      if (!down.has(kind)) down.set(kind, why);
      listed(kind); // a watch that cannot start must not hold the callers: they get its error
      // Reconnecting when the stream ends (the API server closes every watch after a while) is the watch itself, not a poll.
      retries.set(kind, setTimeout(() => connect(kind, resume, failures + 1), Math.min(RETRY_MAX_MS, 500 * 2 ** (failures + 1))));
    }));
  };
  for (const kind of Object.keys(kinds)) connect(kind, null, 0);

  return {
    async espera(apps, since) {
      await ready;
      const until = Date.now() + holdMs;
      for (;;) {
        const completo = since < start || since > version;
        const changed: Record<string, DeployStatus> = {};
        for (const app of apps) {
          const e = shown.get(app);
          if (completo || (e && e.at > since)) changed[app] = e?.status ?? missing(app);
        }
        if (completo || Object.keys(changed).length > 0) return { version, completo, apps: changed };
        const left = until - Date.now();
        if (closed || left <= 0) return { version, completo: false, apps: {} };
        await new Promise<void>((wake) => {
          const done = () => {
            clearTimeout(timer);
            waiting.delete(done);
            wake();
          };
          const timer = setTimeout(done, left);
          waiting.add(done);
        });
      }
    },
    async index() {
      await ready;
      return new Set([...shown].filter(([, e]) => !e.status.error).map(([name]) => name));
    },
    cierra() {
      closed = true;
      for (const t of retries.values()) clearTimeout(t);
      for (const stop of stops.values()) stop();
      for (const wake of [...waiting]) wake();
    },
  };
}
