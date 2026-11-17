import type {
  PluginButtonContentProps,
  PluginButtonIcon,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { agentText, argocdRefs, argocdWatch, isFlux, lastMention, pillLabel, tone, type DeployStatus, type Tone } from "../shared/argocd.ts";

// The slice of the host this module uses: index.client.tsx hands in the plugin context, the tests a fake.
export interface ArgocdPillClient {
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  paseo: Pick<PluginClientContext["paseo"], "agents">;
  rpc: PluginClientContext["rpc"];
}

type PaseoAgent = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>["entries"][number]["agent"];

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
  see: (app: string | null) => void;
}

/**
 * One composer pill per agent whose conversation names an ArgoCD app or a Flux Kustomization/HelmRelease: the helm mark
 * tinted by the deployment state and the name; the popover shows its state, the running operation and what is not ok.
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

  // Each app's state as the daemon last pushed it: a second agent naming a watched app shows it at once.
  const known = new Map<string, DeployStatus>();
  const show = (app: string, deploy: DeployStatus) => {
    known.set(app, deploy);
    for (const [agentId, e] of entries) {
      if (e.app !== app || !live.has(agentId)) continue;
      e.deploy = deploy;
      live.get(agentId)!.reg?.update({ label: pillLabel(app, deploy), icon: icon(tone(deploy)) });
    }
    emit();
  };

  // One held argocd.watch for every app the pills show (SC-5835): the daemon answers when one of them changes, and the next
  // call goes out when the last one answers — never on a clock. The same set leaves the held call alone; a new set (an app
  // named or gone) restarts it asking for all of them once. A failure (daemon gone, plugin reloading) sends nothing until the
  // next agent change, which asks for everything again; the pills keep their last state meanwhile. Asks made in one burst
  // (the refs answer names every agent's app at once) go out as one call.
  let version = 0;
  let holding: object | null = null;
  let held = "";
  let queued = false;
  const watch = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      ask();
    });
  };
  const ask = () => {
    if (stopped) return;
    const apps = [...new Set([...live.keys()].flatMap((id) => entries.get(id)?.app ?? []))].sort();
    const set = apps.join(" ");
    if (holding && set === held) return;
    if (set !== held) version = 0; // an answer only covers the apps it was asked for
    held = set;
    holding = null; // an answer to an older call is dropped
    if (apps.length === 0) return;
    const call = {};
    holding = call;
    void client.rpc(argocdWatch, { apps, since: version }).then(
      (answer) => {
        if (holding !== call) return;
        holding = null;
        version = answer.version;
        for (const [app, deploy] of Object.entries(answer.apps)) show(app, deploy);
        watch();
      },
      () => {
        if (holding !== call) return;
        holding = null;
        version = 0;
      },
    );
  };

  const drop = (agentId: string) => {
    const l = live.get(agentId);
    if (!l) return;
    live.delete(agentId);
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
    const entry: Live = { workspaceId, release: () => Promise.resolve(), reg: null, see: () => {} };
    live.set(agent.id, entry);
    const current = () => live.get(agent.id) === entry;

    entry.see = (app) => {
      if (!app || !current()) return;
      const had = entries.get(agent.id);
      if (had?.app === app) return;
      const deploy = known.get(app) ?? null;
      entries.set(agent.id, { app, deploy });
      const button = { title: isFlux(app) ? `Flux · ${app.slice(3)}` : `ArgoCD · ${app}`, icon: icon(tone(deploy)), label: pillLabel(app, deploy) };
      if (entry.reg) entry.reg.update(button);
      else entry.reg = client.addComposerPill({ id: "argocd", workspaceId, agentId: agent.id, button: { ...button, behavior: { kind: "popover", Content } } });
      emit();
      watch();
    };

    const sub = client.paseo.agents.ref(agent.id).timeline.subscribe((e) => {
      if (!current()) return;
      // Live events have no cluster knowledge: adopt the last named app as it appears (the refs RPC re-validates on restore).
      // Only the session's own text counts, as in the refs RPC: a tool result naming an app must not raise the pill.
      if (e.event.type === "timeline") {
        const app = lastMention(agentText(e.event.item));
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
          watch();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") upsert(message.payload.agent);
          else drop(message.payload.agentId);
          watch(); // a no-op while the held call covers the same apps
        },
      });
    },
    () => {},
  );

  return () => {
    stopped = true;
    holding = null;
    if (batch) clearTimeout(batch);
    lifetime.abort();
    stopAgents?.();
    void agentsSub?.release().catch(() => {});
    for (const agentId of [...live.keys()]) drop(agentId);
  };
}
