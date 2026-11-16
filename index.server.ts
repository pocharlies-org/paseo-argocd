import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentText, argocdRefs, argocdWatch, lastKnown, mentions } from "./shared/argocd.ts";
import { appWatch } from "./server/cluster.ts";
import { timelineCache } from "./server/refs.ts";

// The daemon reads the cluster with its own kubeconfig: no credential reaches the client.
export default function contribute(server: PluginServerContext) {
  const apps = appWatch();
  server.handle(argocdWatch, ({ apps: asked, since }) => apps.espera(asked, since));
  // The timelines are read here, next to the daemon (as in paseo-ci): the client never downloads them. What is kept is
  // every mention, so an app created after the read is still found against the watched cluster index.
  const named = timelineCache((items) => mentions(items.map(agentText).join("\n")));
  server.on("agent.turn_started", ({ agent }) => named.forget(agent.id));
  server.on("agent.turn_ended", ({ agent }) => named.forget(agent.id));
  server.handle(argocdRefs, async ({ agentIds }, { paseo }) => {
    const known = await apps.index();
    return {
      refs: Object.fromEntries(
        await Promise.all(
          agentIds.map(async (id) => {
            const found = await named.get(paseo, id);
            return [id, found ? lastKnown(found, known) : null] as const;
          }),
        ),
      ),
    };
  });
  return () => apps.cierra();
}
