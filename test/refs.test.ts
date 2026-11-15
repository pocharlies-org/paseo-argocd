import { test } from "node:test";
import assert from "node:assert/strict";
import { timelineCache } from "../server/refs.ts";

// A fake daemon: counts reads per agent and the most reads it ever had in flight at once.
function fakeDaemon(failFirst = new Set<string>()) {
  const reads = new Map<string, number>();
  let now = 0;
  let peak = 0;
  const paseo = {
    agents: {
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            reads.set(id, (reads.get(id) ?? 0) + 1);
            peak = Math.max(peak, ++now);
            await new Promise((r) => setTimeout(r, 5));
            now--;
            if (failFirst.delete(id)) throw new Error("daemon busy");
            return { entries: [{ item: { type: "assistant_message", text: `argocd app sync ${id}` } }] };
          },
        },
      }),
    },
  } as never;
  return { paseo, reads, peak: () => peak };
}

test("timelineCache: at most 4 reads at once, each agent read once, forget re-reads only that agent", async () => {
  const d = fakeDaemon();
  const cache = timelineCache((items) => (items[0] as { text: string }).text);
  const ids = Array.from({ length: 30 }, (_, i) => `a${i}`);
  const first = await Promise.all(ids.map((id) => cache.get(d.paseo, id)));
  assert.equal(first[7], "argocd app sync a7");
  assert.ok(d.peak() <= 4, `peak ${d.peak()}`);
  await Promise.all([...ids, ...ids].map((id) => cache.get(d.paseo, id))); // a reconnect storm: two clients, every agent
  assert.ok([...d.reads.values()].every((n) => n === 1));
  cache.forget("a3");
  await Promise.all(ids.map((id) => cache.get(d.paseo, id)));
  assert.equal(d.reads.get("a3"), 2);
  assert.equal([...d.reads.values()].reduce((a, b) => a + b), 31);
});

test("timelineCache: a failed read is not kept", async () => {
  const d = fakeDaemon(new Set(["x"]));
  const cache = timelineCache(() => "ok");
  assert.equal(await cache.get(d.paseo, "x"), null);
  assert.equal(await cache.get(d.paseo, "x"), "ok");
  assert.equal(d.reads.get("x"), 2);
});
