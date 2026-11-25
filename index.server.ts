import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentText, argocdRefs, argocdWatch, esperaArgocd, lastKnown, mentions } from "./shared/argocd.ts";
import { appWatch } from "./server/cluster.ts";
import { timelineCache } from "./server/refs.ts";

// The daemon reads the cluster with its own kubeconfig: no credential reaches the client.
export default function contribute(server: PluginServerContext) {
  const apps = appWatch();
  server.handle(argocdWatch, ({ apps: asked, since }) => apps.espera(asked, since));
  // The timelines are read here, next to the daemon (as in paseo-ci): the client never downloads them. What is kept is
  // every mention, so an app created after the read is still found against the watched cluster index, and whether the
  // session's last word waits on a deployment (the pill turns while so).
  const named = timelineCache((items) => ({ found: mentions(items.map(agentText).join("\n")), waiting: esperaArgocd(items) }));
  server.on("agent.turn_started", ({ agent }) => named.forget(agent.id));
  server.on("agent.turn_ended", ({ agent }) => named.forget(agent.id));
  server.handle(argocdRefs, async ({ agentIds }, { paseo }) => {
    const known = await apps.index();
    const founds = await Promise.all(agentIds.map((id) => named.get(paseo, id)));
    return {
      refs: Object.fromEntries(agentIds.map((id, i) => [id, founds[i] ? lastKnown(founds[i]!.found, known) : null] as const)),
      esperas: Object.fromEntries(agentIds.map((id, i) => [id, founds[i]?.waiting ?? false] as const)),
    };
  });
  return () => apps.cierra();
}
