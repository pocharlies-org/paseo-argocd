import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agentText, argocdGet, argocdRefs, lastAppRef } from "./shared/argocd.ts";
import { clusterIndex, readApp } from "./server/cluster.ts";

// The daemon reads the cluster with its own kubeconfig: no credential reaches the client.
export default function contribute(server: PluginServerContext) {
  server.handle(argocdGet, ({ app }) => readApp(app));
  // The timelines are read here, next to the daemon (as in paseo-ci): the client never downloads them.
  server.handle(argocdRefs, async ({ agentIds }, { paseo }) => {
    const known = await clusterIndex();
    return {
      refs: Object.fromEntries(
        await Promise.all(
          agentIds.map(async (id) => {
            const page = await paseo.agents.ref(id).timeline.refetch({ direction: "before", limit: 200, projection: "projected" }).catch(() => null);
            return [id, page ? lastAppRef(page.entries.map((row) => agentText(row.item)).join("\n"), known) : null] as const;
          }),
        ),
      ),
    };
  });
  return () => {};
}
