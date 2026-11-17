import { test } from "node:test";
import assert from "node:assert/strict";
import { registerArgocdPills, type ArgocdPillClient } from "../client/pills.ts";

const status = (health: string) => ({
  motor: "argocd" as const, url: "", panel: "", sync: "Synced", health, operation: "Succeeded", revision: "abc", message: "",
  startedAt: null, completedAt: null, resources: [], error: null,
});

// A fake host: argocd.refs names each agent's app, argocd.watch answers from a queue the test fills (else stays held), and
// the timeline subscriptions can push a live event.
function fakeHost(refs: Record<string, string | null>) {
  const calls: Array<{ name: string; input: any }> = [];
  const labels = new Map<string, string>();
  const answers: Array<(value: unknown) => void> = [];
  const timelines = new Map<string, (e: unknown) => void>();
  const agent = (id: string) => ({ agent: { id, status: "idle", workspaceId: "w" } });
  const client = {
    addComposerPill: (c: any) => {
      labels.set(c.agentId, c.button.label);
      return { update: (b: any) => labels.set(c.agentId, b.label), remove: () => labels.delete(c.agentId) };
    },
    rpc: (contract: any, input: any) => {
      calls.push({ name: contract.name, input });
      if (contract.name === "argocd.refs") return Promise.resolve({ refs });
      return new Promise((resolve) => answers.push(resolve));
    },
    paseo: {
      agents: {
        list: async () => ({
          entries: Object.keys(refs).map(agent),
          subscription: { subscribe: () => () => {}, release: async () => {} },
        }),
        ref: (id: string) => ({
          timeline: {
            refetch: () => assert.fail("the client must not download timelines"),
            subscribe: (fn: (e: unknown) => void) => (timelines.set(id, fn), { ready: Promise.resolve(), release: async () => {} }),
          },
        }),
      },
    },
  } as unknown as ArgocdPillClient;
  return { client, calls, labels, answers, timelines };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("registerArgocdPills: one argocd.refs for every agent, no timeline download", async () => {
  const host = fakeHost({ a: "paseo", b: null });
  const stop = registerArgocdPills(host.client, () => null, () => ({ name: "x" }) as never);
  await tick();
  assert.deepEqual(host.calls.filter((c) => c.name === "argocd.refs").map((c) => c.input), [{ agentIds: ["a", "b"] }]);
  assert.deepEqual([...host.labels], [["a", "paseo"]]);
  stop();
});

test("registerArgocdPills: one held argocd.watch for every app, the next only when it answers — no clock", async () => {
  const host = fakeHost({ a: "paseo", b: "paseo", c: "web" });
  const stop = registerArgocdPills(host.client, () => null, () => ({ name: "x" }) as never);
  await tick();
  const watches = () => host.calls.filter((c) => c.name === "argocd.watch").map((c) => c.input);
  assert.deepEqual(watches(), [{ apps: ["paseo", "web"], since: 0 }], "one call for the set, not one per agent");
  assert.ok(!host.calls.some((c) => c.name === "argocd.get"), "nothing asks argocd.get");

  host.answers.shift()!({ version: 7, completo: true, apps: { paseo: status("Healthy"), web: status("Progressing") } });
  await tick();
  assert.equal(host.labels.get("a"), "paseo ✓ Synced·Healthy");
  assert.equal(host.labels.get("b"), "paseo ✓ Synced·Healthy");
  assert.equal(host.labels.get("c"), "web ◐ Synced·Progressing");
  assert.deepEqual(watches().at(-1), { apps: ["paseo", "web"], since: 7 }, "the next call resumes from the answer's version");

  await tick(50);
  assert.equal(watches().length, 2, "while the daemon holds the call nothing else goes out");

  host.answers.shift()!({ version: 8, completo: false, apps: { web: status("Healthy") } });
  await tick();
  assert.equal(host.labels.get("c"), "web ✓ Synced·Healthy");
  assert.equal(host.labels.get("a"), "paseo ✓ Synced·Healthy", "an app the answer does not bring keeps its state");
  stop();
});

test("registerArgocdPills: a newly named app restarts the watch for the new set; a known one shows at once", async () => {
  const host = fakeHost({ a: "paseo", b: null, c: null });
  const stop = registerArgocdPills(host.client, () => null, () => ({ name: "x" }) as never);
  await tick();
  host.answers.shift()!({ version: 3, completo: true, apps: { paseo: status("Healthy") } });
  await tick();
  const said = (id: string, text: string) =>
    host.timelines.get(id)!({ event: { type: "timeline", item: { type: "assistant_message", text } } });
  said("b", "ESPERA: argocd paseo");
  assert.equal(host.labels.get("b"), "paseo ✓ Synced·Healthy", "the pushed state of a watched app needs no call");
  said("c", "argocd app sync web");
  await tick();
  const watches = host.calls.filter((c) => c.name === "argocd.watch").map((c) => c.input);
  assert.deepEqual(watches.at(-1), { apps: ["paseo", "web"], since: 0 }, "a new set asks for all of it once");
  assert.equal(watches.length, 3);
  stop();
});
