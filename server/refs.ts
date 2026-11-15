import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type Paseo = PluginHandlerContext["paseo"];
type Item = Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["timeline"]["refetch"]>>["entries"][number]["item"];

const MAX_READS = 4; // timeline reads at once: each can wake a stored agent in the daemon

/**
 * What each agent's timeline says, read once and kept until that agent's next turn starts or ends (`forget`). Every
 * client asks for every agent on each reconnect; re-reading 200 rows per agent, plugin and client each time drowned the
 * daemon (SC-5592). Concurrent asks for one agent share its read; a failed read is not kept.
 */
export function timelineCache<T>(scan: (items: Item[]) => T) {
  const kept = new Map<string, Promise<T | null>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async <R>(read: () => Promise<R>): Promise<R> => {
    if (active < MAX_READS) active++;
    else await new Promise<void>((go) => waiting.push(go)); // the read that finishes hands its slot over
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  return {
    get(paseo: Paseo, agentId: string): Promise<T | null> {
      const hit = kept.get(agentId);
      if (hit) return hit;
      const read: Promise<T | null> = slot(() =>
        paseo.agents.ref(agentId).timeline.refetch({ direction: "before", limit: 200, projection: "projected" }),
      )
        .then((page) => scan(page.entries.map((row) => row.item)))
        .catch(() => {
          if (kept.get(agentId) === read) kept.delete(agentId);
          return null;
        });
      kept.set(agentId, read);
      return read;
    },
    forget(agentId: string) {
      kept.delete(agentId);
    },
  };
}
