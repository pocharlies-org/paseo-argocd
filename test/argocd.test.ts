import { test } from "node:test";
import assert from "node:assert/strict";
import { agentText, deployState, lastAppRef, lastMention, pillLabel, tone } from "../shared/argocd.ts";
import { parseApp } from "../server/cluster.ts";

const known = new Set(["paseo", "web", "litellm"]);
const app = (text: string) => lastAppRef(text, known);

test("lastAppRef: every form, the last existing one wins", () => {
  assert.equal(app('{"command":"argocd app sync paseo --prune"}'), "paseo");
  assert.equal(app("ESPERA: argocd web → llega a producción"), "web");
  assert.equal(app('{"command":"kubectl get application litellm -n argocd -o json"}'), "litellm");
  assert.equal(app('{"command":"kubectl -n argocd get apps paseo"}'), "paseo");
  assert.equal(app("https://argocd.lan.e-dani.com/applications/argocd/web?resource=application"), "web");
  assert.equal(app("argocd app sync web y luego argocd app sync paseo"), "paseo");
  assert.equal(app("argocd app sync noexiste"), null); // not in the cluster: no pill
  assert.equal(app("kubectl get applications -n argocd"), null); // a list, not one app
  assert.equal(app("kubectl get cm gpu-arbiter-state -n comfyui"), null);
});

test("lastAppRef: a repo name alone is not a mention", () => {
  assert.equal(app("fusionado k8s-paseo-pocharlies#7, ArgoCD despliega"), null);
  assert.equal(app("el repo k8s-paseo-pocharlies lee deploy/prod"), null);
});

test("agentText: only what the session wrote or ran", () => {
  assert.equal(agentText({ type: "user_message", text: "ESPERA: argocd web" }), "ESPERA: argocd web");
  assert.equal(agentText({ type: "assistant_message", text: "argocd app sync paseo" }), "argocd app sync paseo");
  assert.equal(
    agentText({ type: "tool_call", detail: { type: "shell", command: "kubectl get application paseo -n argocd" } }),
    "kubectl get application paseo -n argocd",
  );
  // the output of a tool is not the session's text: a skill loaded there does not link its app
  assert.equal(agentText({ type: "tool_call", detail: { type: "other" } }), "");
  assert.equal(agentText({ type: "reasoning", text: "argocd app sync paseo" }), "");
  assert.equal(agentText(null), "");
  // the live path (client/pills.ts): a tool event whose output contains a pattern must not raise the pill
  const toolEvent = { type: "tool_call", detail: { type: "other", content: "ESPERA: argocd paseo" } };
  assert.equal(lastMention(agentText(toolEvent)), null);
  // end to end over a timeline: the skill text names the app, the session never does → no pill
  const timeline = [
    { type: "tool_call", detail: { type: "other" } }, // skill_load: its result (k8s-agentjake-chrome-pocharlies) is not scanned
    { type: "reasoning", text: 'usaré el navegador: argocd app get agentjake-chrome' },
    { type: "assistant_message", text: "compruebo el estado de la suscripción" },
  ];
  assert.equal(lastAppRef(timeline.map(agentText).join("\n"), new Set(["agentjake-chrome"])), null);
});

test("lastMention needs no cluster", () => {
  assert.equal(lastMention('{"command":"argocd app wait skirmshop-labels -n argocd"}'), "skirmshop-labels");
  assert.equal(lastMention("nada de argocd aquí"), null);
});

test("deployState, tone and label", () => {
  const d = (sync: string, health: string, operation = "") => ({ sync, health, operation });
  assert.equal(deployState(d("Synced", "Healthy", "Succeeded")), "success");
  assert.equal(deployState(d("OutOfSync", "Healthy", "Running")), "pending");
  assert.equal(deployState(d("Synced", "Progressing")), "pending");
  assert.equal(deployState(d("Synced", "Degraded")), "failure");
  assert.equal(deployState(d("Synced", "Healthy", "Failed")), "failure");
  assert.equal(deployState(d("OutOfSync", "Missing")), "none");
  const full = (sync: string, health: string, operation = "", error: string | null = null) => ({
    url: "", sync, health, operation, revision: "", message: "", startedAt: null, completedAt: null, resources: [], error,
  });
  assert.equal(pillLabel("paseo", full("Synced", "Healthy", "Succeeded")), "paseo ✓");
  assert.equal(pillLabel("paseo", full("OutOfSync", "Progressing", "Running")), "paseo ◐");
  assert.equal(pillLabel("paseo", full("Synced", "Degraded")), "paseo ✗");
  assert.equal(pillLabel("paseo", full("OutOfSync", "Healthy")), "paseo · out");
  assert.equal(pillLabel("paseo", null), "paseo");
  assert.equal(pillLabel("paseo", full("", "", "", "kubectl: not found")), "paseo ?");
  assert.equal(tone(full("OutOfSync", "Healthy")), null); // at rest: no colour
  assert.equal(tone(full("Synced", "Healthy", "Running")), "pending");
  assert.equal(tone(full("Synced", "Healthy", "", "boom")), null);
});

test("parseApp: a live Application JSON", () => {
  const a = parseApp("paseo", {
    spec: { source: { repoURL: "https://github.com/pocharlies-org/k8s-paseo-pocharlies" }, targetRevision: "deploy/prod" },
    status: {
      sync: { status: "Synced", revision: "8523e00c709f1c13199f84543340ce40f8603b25" },
      health: { status: "Progressing", message: "waiting for rollout to finish" },
      operationState: { phase: "Running", startedAt: "2026-11-10T10:00:00Z" },
      resources: [
        { kind: "StatefulSet", name: "paseo", namespace: "paseo", status: "Synced", health: { status: "Progressing", message: "0/1 replicas" } },
        { kind: "Service", name: "paseo", namespace: "paseo", status: "Synced", health: { status: "Healthy" } },
      ],
    },
  });
  assert.deepEqual([a.sync, a.health, a.operation, a.revision.slice(0, 7)], ["Synced", "Progressing", "Running", "8523e00"]);
  assert.equal(a.message, "waiting for rollout to finish");
  assert.deepEqual(a.resources.map((r) => r.key), ["StatefulSet/paseo/paseo"]); // only the one that is not ok
  assert.match(a.url, /argocd\.lan\.e-dani\.com\/applications\/argocd\/paseo$/);
});
