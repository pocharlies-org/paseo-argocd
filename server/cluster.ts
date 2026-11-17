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

const empty: DeployStatus = {
  url: "", panel: "", sync: "Unknown", health: "Unknown", operation: "", revision: "", message: "",
  startedAt: null, completedAt: null, resources: [], error: null,
};

const HOLD_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout
const RETRY_MAX_MS = 30_000;

/** One watch request on the Applications: each line of the stream to `line`, then `closed` once with why it ended. Returns its stop. */
export type OpenWatch = (query: string, line: (text: string) => void, closed: (why: string) => void) => () => void;

const openKubectl: OpenWatch = (query, line, closed) => {
  const child = spawnProcess("kubectl", ["get", "--raw", `/apis/argoproj.io/v1alpha1/namespaces/${NS}/applications?${query}`], { env, stdio: "pipe" });
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
 * ArgoCD pushes to nobody, so the plugin's server holds the one edge (SC-5835): a single Kubernetes watch on the Applications
 * (`kubectl get --raw …?watch=1`), however many clients and agents. The first request streams every app and ends its initial
 * events with a bookmark; a closed stream resumes from the last resourceVersion, and an expired one (410) lists again and drops
 * the apps that did not come back. Only what a pill shows counts as a change: ArgoCD rewrites each Application on every
 * reconcile, and those writes wake nobody.
 * shortcut: <while the watch is down the last state stays on the pills>, <mark them stale if outages turn out to last>.
 */
export function appWatch(open: OpenWatch = openKubectl, holdMs = HOLD_MS): AppWatch {
  // A `since` from before this instance (the plugin was reloaded) is older than its start: that caller gets everything again.
  const start = Date.now();
  let version = start;
  const shown = new Map<string, { status: DeployStatus; key: string; at: number }>();
  const waiting = new Set<() => void>();
  let down: string | null = null; // why the watch is not streaming, while it is not
  let resume: string | null = null; // resourceVersion to resume from; null = list everything again
  let stop: () => void = () => {};
  let closed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let listed!: () => void;
  const ready = new Promise<void>((r) => (listed = r));

  const put = (name: string, status: DeployStatus) => {
    const key = JSON.stringify(status);
    if (shown.get(name)?.key === key) return;
    shown.set(name, { status, key, at: ++version });
    for (const wake of [...waiting]) wake();
  };
  const missing = (name: string): DeployStatus => ({ ...empty, error: down ?? `${name} no existe en ArgoCD (${NS})` });

  const connect = () => {
    if (closed) return;
    const seen = new Set<string>();
    const from = resume
      ? `&resourceVersion=${encodeURIComponent(resume)}`
      : "&sendInitialEvents=true&resourceVersionMatch=NotOlderThan";
    // One bad event must not end the watch: a throw here leaves the readline handler and kills the plugin process, which
    // the daemon never restarts — every later call then times out (SC-5922).
    const onLine = (text: string) => {
      let event: { type?: string; object?: AppJson & { code?: number; message?: string } };
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      const o = event.object ?? ({} as NonNullable<typeof event.object>);
      if (event.type === "ERROR") {
        if (o.code === 410) resume = null; // too old to resume: list again on the next connect
        down = o.message ?? "error del watch de ArgoCD";
        return;
      }
      failures = 0;
      down = null;
      if (o.metadata?.resourceVersion) resume = o.metadata.resourceVersion;
      const name = o.metadata?.name;
      if ((event.type === "ADDED" || event.type === "MODIFIED") && name) {
        seen.add(name);
        put(name, parseApp(name, o));
      } else if (event.type === "DELETED" && name) put(name, missing(name));
      else if (event.type === "BOOKMARK" && o.metadata?.annotations?.["k8s.io/initial-events-end"] === "true") {
        for (const old of [...shown.keys()]) if (!seen.has(old)) put(old, missing(old)); // deleted while the watch was away
        listed();
      }
    };
    stop = open(`watch=1&allowWatchBookmarks=true${from}`, (text) => {
      try {
        onLine(text);
      } catch (e) {
        console.error(`paseo-argocd: evento del watch descartado: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, (why) => {
      if (closed) return;
      down ??= why;
      listed(); // a watch that cannot start must not hold the callers: they get its error
      failures += 1;
      // Reconnecting when the stream ends (the API server closes every watch after a while) is the watch itself, not a poll.
      retry = setTimeout(connect, Math.min(RETRY_MAX_MS, 500 * 2 ** failures));
    });
  };
  connect();

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
      clearTimeout(retry);
      stop();
      for (const wake of [...waiting]) wake();
    },
  };
}
