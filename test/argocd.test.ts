import { test } from "node:test";
import assert from "node:assert/strict";
import { agentText, deployState, lastKnown, lastMention, mentions, pillLabel, tone } from "../shared/argocd.ts";

const known = new Set(["paseo", "web", "litellm"]);
const app = (text: string) => lastKnown(mentions(text), known);

test("lastKnown: every form, the last existing one wins", () => {
  assert.equal(app('{"command":"argocd app sync paseo --prune"}'), "paseo");
  assert.equal(app("ESPERA: argocd web → llega a producción"), "web");
  assert.equal(app('{"command":"kubectl get application litellm -n argocd -o json"}'), "litellm");
  assert.equal(app('{"command":"kubectl -n argocd get apps paseo"}'), "paseo");
  assert.equal(app("https://argocd.example.com/applications/argocd/web?resource=application"), "web");
  assert.equal(app("argocd app sync web y luego argocd app sync paseo"), "paseo");
  assert.equal(app("argocd app sync noexiste"), null); // not in the cluster: no pill
  assert.equal(app("kubectl get applications -n argocd"), null); // a list, not one app
  assert.equal(app("kubectl get cm gpu-arbiter-state -n comfyui"), null);
});

test("lastKnown: a repo name alone is not a mention", () => {
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
  assert.equal(lastKnown(mentions(timeline.map(agentText).join("\n")), new Set(["agentjake-chrome"])), null);
});

test("lastMention needs no cluster", () => {
  assert.equal(lastMention('{"command":"argocd app wait skirmshop-labels -n argocd"}'), "skirmshop-labels");
  assert.equal(lastMention("nada de argocd aquí"), null);
});

test("deployState, tone and label", () => {
  const d = (sync: string, health: string, operation = "") => ({ motor: "argocd", sync, health, operation });
  assert.equal(deployState(d("Synced", "Healthy", "Succeeded")), "success");
  assert.equal(deployState(d("OutOfSync", "Healthy", "Running")), "pending");
  assert.equal(deployState(d("Synced", "Progressing")), "pending");
  assert.equal(deployState(d("Synced", "Degraded")), "failure");
  assert.equal(deployState(d("Synced", "Healthy", "Failed")), "failure");
  assert.equal(deployState(d("OutOfSync", "Missing")), "none");
  const full = (sync: string, health: string, operation = "", error: string | null = null) => ({
    motor: "argocd" as const,
    url: "", panel: "", sync, health, operation, revision: "", message: "", startedAt: null, completedAt: null, resources: [], error,
  });
  assert.equal(pillLabel("paseo", full("Synced", "Healthy", "Succeeded")), "paseo ✓ Synced·Healthy");
  assert.equal(pillLabel("paseo", full("OutOfSync", "Progressing", "Running")), "paseo ◐ OutOfSync·Progressing");
  assert.equal(pillLabel("paseo", full("Synced", "Degraded")), "paseo ✗ Synced·Degraded");
  assert.equal(pillLabel("paseo", full("OutOfSync", "Healthy")), "paseo · OutOfSync·Healthy");
  assert.equal(pillLabel("paseo", null), "paseo");
  assert.equal(pillLabel("paseo", full("", "", "", "kubectl: not found")), "paseo ?");
  assert.equal(tone(full("OutOfSync", "Healthy")), null); // at rest: no colour
  assert.equal(tone(full("Synced", "Healthy", "Running")), "pending");
  assert.equal(tone(full("Synced", "Healthy", "", "boom")), null);
});

test("parseApp: a live Application JSON, URL from ARGOCD_UI and panel from PASEO_ARGOCD_PANEL", async () => {
  process.env.ARGOCD_UI = "https://argocd.example.com/applications/argocd/";
  process.env.PASEO_ARGOCD_PANEL = "https://dgx.example.com/";
  const { parseApp } = await import("../server/cluster.ts");
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
  assert.equal(a.url, "https://argocd.example.com/applications/argocd/paseo");
  assert.equal(a.panel, "https://dgx.example.com/services?mode=argocd&app=paseo");
});

test("lastKnown: kept mentions are re-checked against a newer cluster index", () => {
  const found = mentions("argocd app sync nueva y luego ESPERA: argocd web");
  assert.equal(lastKnown(found, new Set(["paseo"])), null);
  assert.equal(lastKnown(found, new Set(["nueva"])), "nueva");
  assert.equal(lastKnown(found, new Set(["nueva", "web"])), "web");
});

test("Flux: the session's own flux and kubectl commands name a Kustomization or HelmRelease, flux-system by default", () => {
  const flux = new Set(["ks/flux-system/apps", "hr/devopsai/agent-framework", "ks/infra/apps", "paseo"]);
  const of = (text: string) => lastKnown(mentions(text), flux);
  assert.equal(of('{"command":"flux reconcile kustomization apps --with-source"}'), "ks/flux-system/apps");
  assert.equal(of('{"command":"flux reconcile ks apps -n infra"}'), "ks/infra/apps");
  assert.equal(of('{"command":"flux get helmreleases agent-framework --namespace devopsai"}'), "hr/devopsai/agent-framework");
  assert.equal(of('{"command":"kubectl -n devopsai get hr agent-framework -o yaml"}'), "hr/devopsai/agent-framework");
  assert.equal(of('{"command":"kubectl describe kustomization.kustomize.toolkit.fluxcd.io apps -n flux-system"}'), "ks/flux-system/apps");
  assert.equal(of('{"command":"flux get kustomizations -A"}'), null); // a list, not one object
  assert.equal(of("argocd app sync paseo y luego flux reconcile ks apps"), "ks/flux-system/apps"); // the last one wins
  assert.equal(of('{"command":"flux reconcile ks apps; argocd app sync paseo"}'), "paseo");
});

test("Flux: state and label in Flux's words", () => {
  const f = (sync: string, health: string, operation = "", error: string | null = null) => ({
    motor: "flux" as const, url: "", panel: "", sync, health, operation, revision: "", message: "", startedAt: null, completedAt: null,
    resources: [], error,
  });
  assert.equal(pillLabel("ks/flux-system/apps", f("Ready", "ReconciliationSucceeded")), "apps ✓ Ready");
  assert.equal(pillLabel("hr/devopsai/agent-framework", f("NotReady", "HealthCheckFailed")), "agent-framework ✗ HealthCheckFailed");
  assert.equal(pillLabel("ks/flux-system/apps", f("Unknown", "Progressing", "Running")), "apps ◐ Progressing");
  assert.equal(pillLabel("ks/flux-system/apps", f("Ready", "Suspended")), "apps · Suspended");
  assert.equal(tone(f("Ready", "Suspended")), null);
  assert.equal(pillLabel("ks/flux-system/apps", f("", "", "", "Flux no está en este clúster")), "apps ?");
});

test("parseFlux: a Kustomization and a HelmRelease as the API returns them", async () => {
  const { parseFlux } = await import("../server/cluster.ts"); // dynamic: the parseApp test sets its env before the first load
  const ks = parseFlux({
    spec: {},
    status: {
      lastAppliedRevision: "main@sha1:77fa32a6e51e9d7dc4ad494e42a33214136c235d",
      conditions: [{ type: "Ready", status: "False", reason: "HealthCheckFailed", message: "timeout waiting for: [Deployment/devopsai/aurora]" }],
    },
  });
  assert.deepEqual([ks.motor, ks.sync, ks.health, ks.revision, ks.message], [
    "flux", "NotReady", "HealthCheckFailed", "77fa32a", "timeout waiting for: [Deployment/devopsai/aurora]",
  ]);
  const hr = parseFlux({
    status: {
      history: [{ chartVersion: "0.8.2+b1b6a93fa922" }],
      conditions: [{ type: "Ready", status: "True", reason: "UpgradeSucceeded" }, { type: "Reconciling", status: "True" }],
    },
  });
  assert.deepEqual([hr.sync, hr.health, hr.operation, hr.revision], ["Ready", "UpgradeSucceeded", "Running", "0.8.2+b1b6a93fa922"]);
  assert.equal(deployState(hr), "pending");
  assert.equal(parseFlux({ spec: { suspend: true } }).health, "Suspended");
});
