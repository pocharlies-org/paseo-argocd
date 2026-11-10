import { test } from "node:test";
import assert from "node:assert/strict";
import { registerArgocdPills, type ArgocdPillClient } from "../client/pills.ts";

test("registerArgocdPills: one argocd.refs for every agent, no timeline download", async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const pills: string[] = [];
  const agent = (id: string) => ({ agent: { id, status: "idle", workspaceId: "w" } });
  const client = {
    addComposerPill: (c: any) => (pills.push(`${c.agentId} ${c.button.label}`), { update() {}, remove() {} }),
    rpc: async (contract: any, input: any) => {
      calls.push({ name: contract.name, input });
      if (contract.name === "argocd.refs") return { refs: { a: "paseo", b: null } };
      return {
        url: "https://argocd.lan.e-dani.com/applications/argocd/paseo", sync: "OutOfSync", health: "Progressing",
        operation: "Running", revision: "abc", message: "", startedAt: null, completedAt: null, resources: [], error: null,
      };
    },
    paseo: {
      agents: {
        list: async () => ({
          entries: [agent("a"), agent("b")],
          subscription: { subscribe: () => () => {}, release: async () => {} },
        }),
        ref: () => ({
          timeline: {
            refetch: () => assert.fail("the client must not download timelines"),
            subscribe: () => ({ ready: Promise.resolve(), release: async () => {} }),
          },
        }),
      },
    },
  } as unknown as ArgocdPillClient;
  const stop = registerArgocdPills(client, () => null, () => ({ name: "x" }) as never);
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.deepEqual(calls.filter((c) => c.name === "argocd.refs").map((c) => c.input), [{ agentIds: ["a", "b"] }]);
  assert.deepEqual(pills, ["a paseo"]);
});
