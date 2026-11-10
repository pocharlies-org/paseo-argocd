import type {
  PluginButtonContentProps,
  PluginButtonIcon,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { argocdGet, argocdRefs, deployState, lastMention, pillLabel, tone, type DeployStatus, type Tone } from "../shared/argocd.ts";

// The slice of the host this module uses: index.client.tsx hands in the plugin context, the tests a fake.
export interface ArgocdPillClient {
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  paseo: Pick<PluginClientContext["paseo"], "agents">;
  rpc: PluginClientContext["rpc"];
}

type PaseoAgent = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>["entries"][number]["agent"];

const POLL_RUNNING_MS = 10_000; // a sync or a rollout moves in seconds
const POLL_SETTLED_MS = 120_000; // settled apps still move on a new merge

/** What each agent's pill shows, shared with the popover so both read one fetch. */
export interface ArgocdEntry {
  app: string;
  deploy: DeployStatus | null;
}
const entries = new Map<string, ArgocdEntry>();
const listeners = new Set<() => void>();
export const argocdEntry = (agentId: string) => entries.get(agentId) ?? null;
export function subscribeArgocd(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn());

interface Live {
  workspaceId: string;
  release: () => Promise<void>;
  reg: PluginButtonRegistration | null;
  timer: ReturnType<typeof setTimeout> | null;
  see: (app: string | null) => void;
}

/**
 * One composer pill per agent whose conversation names an ArgoCD app: the helm mark tinted by the deployment state
 * and the app name; the popover shows sync, health, the running operation and the resources that are not ok.
 * shortcut: one app per agent (the last named), upgrade if agents juggle several deployments.
 */
export function registerArgocdPills(
  client: ArgocdPillClient,
  Content: ComponentType<PluginButtonContentProps>,
  icon: (tone: Tone) => PluginButtonIcon,
): () => void {
  const live = new Map<string, Live>();
  const lifetime = new AbortController();
  let stopped = false;
  let stopAgents: (() => void) | undefined;
  let agentsSub: { release(): Promise<void> } | undefined;

  // One argocd.refs for every agent whose app is wanted now: the agent list arrives at once, restored subscriptions in bursts.
  const wanted = new Set<string>();
  let batch: ReturnType<typeof setTimeout> | null = null;
  const lookup = (agentId: string) => {
    wanted.add(agentId);
    batch ??= setTimeout(() => {
      batch = null;
      const agentIds = [...wanted];
      wanted.clear();
      void client.rpc(argocdRefs, { agentIds }).then(({ refs }) => {
        for (const id of agentIds) live.get(id)?.see(refs[id] ?? null);
      }, () => {});
    }, 0);
  };

  const drop = (agentId: string) => {
    const l = live.get(agentId);
    if (!l) return;
    live.delete(agentId);
    if (l.timer) clearTimeout(l.timer);
    l.reg?.remove();
    entries.delete(agentId);
    emit();
    void l.release().catch(() => {}); // a subscription that never established rejects on release: expected
  };

  const upsert = (agent: PaseoAgent) => {
    if (stopped || agent.status === "closed" || !agent.workspaceId) return drop(agent.id);
    const existing = live.get(agent.id);
    if (existing) {
      if (existing.workspaceId === agent.workspaceId) return;
      drop(agent.id); // moved workspace: the pill is registered under the old one
    }
    const workspaceId = agent.workspaceId;
    const entry: Live = { workspaceId, release: () => Promise.resolve(), reg: null, timer: null, see: () => {} };
    live.set(agent.id, entry);
    const current = () => live.get(agent.id) === entry;

    const poll = async () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      const e = entries.get(agent.id);
      if (!e || !current()) return;
      const deploy = await client.rpc(argocdGet, { app: e.app }).catch((err: Error) => ({ ...noDeploy, error: String(err.message) }));
      if (!current() || entries.get(agent.id) !== e) return; // dropped, or a newer app replaced it meanwhile
      e.deploy = deploy;
      entry.reg?.update({ label: pillLabel(e.app, deploy), icon: icon(tone(deploy)) });
      emit();
      entry.timer = setTimeout(() => void poll(), busy(deploy) ? POLL_RUNNING_MS : POLL_SETTLED_MS);
    };

    entry.see = (app) => {
      if (!app || !current()) return;
      const had = entries.get(agent.id);
      if (had?.app === app) return;
      entries.set(agent.id, { app, deploy: null });
      const button = { title: `ArgoCD · ${app}`, icon: icon(null), label: pillLabel(app, null) };
      if (entry.reg) entry.reg.update(button);
      else entry.reg = client.addComposerPill({ id: "argocd", workspaceId, agentId: agent.id, button: { ...button, behavior: { kind: "popover", Content } } });
      emit();
      void poll();
    };

    const sub = client.paseo.agents.ref(agent.id).timeline.subscribe((e) => {
      if (!current()) return;
      // Live events have no cluster knowledge: adopt the last named app as it appears (the refs RPC re-validates on restore).
      if (e.event.type === "timeline") {
        const app = lastMention(JSON.stringify(e.event.item));
        if (app) entry.see(app);
      } else if (e.event.type === "replacement" || e.event.type === "subscription_restored") lookup(agent.id);
    });
    sub.ready.catch(() => {});
    entry.release = () => sub.release();
    lookup(agent.id);
  };

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(
    (result) => {
      if (stopped) {
        void result.subscription.release().catch(() => {});
        return;
      }
      agentsSub = result.subscription;
      for (const e of result.entries) upsert(e.agent);
      stopAgents = result.subscription.subscribe({
        snapshot: ({ entries: all }) => {
          const present = new Set(all.map((e) => e.agent.id));
          for (const e of all) upsert(e.agent);
          for (const agentId of [...live.keys()]) if (!present.has(agentId)) drop(agentId);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") upsert(message.payload.agent);
          else drop(message.payload.agentId);
        },
      });
    },
    () => {},
  );

  return () => {
    stopped = true;
    if (batch) clearTimeout(batch);
    lifetime.abort();
    stopAgents?.();
    void agentsSub?.release().catch(() => {});
    for (const agentId of [...live.keys()]) drop(agentId);
  };
}

const noDeploy: DeployStatus = {
  url: "", sync: "Unknown", health: "Unknown", operation: "", revision: "", message: "",
  startedAt: null, completedAt: null, resources: [], error: null,
};

const busy = (d: DeployStatus) => !d.error && deployState(d) === "pending";
