import { test } from "node:test";
import assert from "node:assert/strict";
import { KINDS, appWatch, type OpenWatch } from "../server/cluster.ts";

// A fake API server: records each watch request; the test pushes its lines and closes it.
function fakeApi() {
  const opened: Array<{ path: string; query: string; line: (t: string) => void; closed: (why: string) => void }> = [];
  const open: OpenWatch = (path, query, line, closed) => (opened.push({ path, query, line, closed }), () => {});
  return { open, opened, last: () => opened.at(-1)!, of: (part: string) => opened.filter((o) => o.path.includes(part)).at(-1)! };
}
const ARGO = { app: KINDS.app! }; // the ArgoCD-only watch the first tests exercise
const app = (name: string, rv: string, health = "Healthy", reconciledAt = "t0") => ({
  metadata: { name, resourceVersion: rv },
  spec: {},
  status: { sync: { status: "Synced", revision: "abc" }, health: { status: health }, reconciledAt },
});
const ev = (type: string, object: unknown) => JSON.stringify({ type, object });
const initialEnd = (rv: string) => ev("BOOKMARK", { metadata: { resourceVersion: rv, annotations: { "k8s.io/initial-events-end": "true" } } });
const tick = () => new Promise((r) => setImmediate(r));

test("appWatch: one watch streams the initial apps; callers wait for the whole list", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 10, ARGO);
  assert.equal(api.opened.length, 1);
  assert.match(api.last().query, /watch=1.*sendInitialEvents=true&resourceVersionMatch=NotOlderThan/);
  const first = w.espera(["paseo", "nada"], 0);
  api.last().line(ev("ADDED", app("paseo", "1")));
  api.last().line(ev("ADDED", app("web", "2")));
  api.last().line(initialEnd("3"));
  const r = await first;
  assert.equal(r.completo, true);
  assert.equal(r.apps.paseo!.health, "Healthy");
  assert.match(r.apps.nada!.error!, /no existe/);
  assert.deepEqual([...(await w.index())].sort(), ["paseo", "web"]);
  w.cierra();
});

test("appWatch: holds the call until an asked app changes what a pill shows, and answers only that", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 5_000, ARGO);
  api.last().line(ev("ADDED", app("paseo", "1")));
  api.last().line(ev("ADDED", app("web", "2")));
  api.last().line(initialEnd("3"));
  const { version } = await w.espera(["paseo"], 0);
  let answered = false;
  const held = w.espera(["paseo"], version).then((r) => ((answered = true), r));
  api.last().line(ev("MODIFIED", app("web", "4", "Degraded"))); // not asked
  api.last().line(ev("MODIFIED", app("paseo", "5", "Healthy", "t1"))); // a reconcile: nothing a pill shows
  await tick();
  assert.equal(answered, false);
  api.last().line(ev("MODIFIED", app("paseo", "6", "Progressing")));
  const r = await held;
  assert.equal(r.completo, false);
  assert.deepEqual(Object.keys(r.apps), ["paseo"]);
  assert.equal(r.apps.paseo!.health, "Progressing");
  assert.ok(r.version > version);
  w.cierra();
});

test("appWatch: an expired hold answers empty; a since from another instance gets everything", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 10, ARGO);
  api.last().line(ev("ADDED", app("paseo", "1")));
  api.last().line(initialEnd("2"));
  const { version } = await w.espera(["paseo"], 0);
  assert.deepEqual(await w.espera(["paseo"], version), { version, completo: false, apps: {} });
  assert.equal((await w.espera(["paseo"], version - 1e9)).completo, true);
  w.cierra();
});

test("appWatch: a closed stream resumes from the last resourceVersion; a 410 lists again and drops what did not come back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = fakeApi();
  const w = appWatch(api.open, 10_000, ARGO);
  api.last().line(ev("ADDED", app("paseo", "1")));
  api.last().line(ev("ADDED", app("viejo", "2")));
  api.last().line(initialEnd("3"));
  api.last().line(ev("MODIFIED", app("paseo", "9")));
  api.last().closed("kubectl salió con 0"); // the API server ends every watch after a while
  t.mock.timers.tick(30_000);
  assert.equal(api.opened.length, 2);
  assert.match(api.last().query, /resourceVersion=9$/);

  api.last().line(ev("ERROR", { kind: "Status", code: 410, message: "too old resource version" }));
  api.last().closed("kubectl salió con 0");
  t.mock.timers.tick(30_000);
  assert.equal(api.opened.length, 3);
  assert.match(api.last().query, /sendInitialEvents=true/);
  api.last().line(ev("ADDED", app("paseo", "20")));
  api.last().line(initialEnd("21"));
  assert.deepEqual([...(await w.index())], ["paseo"], "viejo was deleted while the watch was away");
  w.cierra();
});

test("appWatch: a watch that cannot start answers with its error instead of holding the callers", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 10, ARGO);
  api.last().closed("The connection to the server was refused");
  const r = await w.espera(["paseo"], 0);
  assert.equal(r.apps.paseo!.error, "The connection to the server was refused");
  assert.deepEqual([...(await w.index())], []);
  w.cierra();
});

test("appWatch: a new Application arrives without status (ADDED before ArgoCD reconciles it) and the watch goes on", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 5_000, ARGO);
  api.last().line(ev("ADDED", app("paseo", "1")));
  api.last().line(initialEnd("2"));
  const { version } = await w.espera(["paseo"], 0);
  const held = w.espera(["nueva"], version);
  api.last().line(ev("ADDED", { metadata: { name: "nueva", resourceVersion: "3" }, spec: {} }));
  const r = await held;
  assert.equal(r.apps.nueva!.sync, "Unknown");
  assert.equal(r.apps.nueva!.health, "Unknown");
  assert.equal(r.apps.nueva!.error, null);
  const next = w.espera(["nueva"], r.version);
  api.last().line(ev("MODIFIED", app("nueva", "4")));
  assert.equal((await next).apps.nueva!.health, "Healthy");
  w.cierra();
});

test("appWatch: an event that cannot be parsed is dropped without ending the watch", async () => {
  const api = fakeApi();
  const w = appWatch(api.open, 5_000, ARGO);
  api.last().line(initialEnd("1"));
  const { version } = await w.espera(["paseo"], 0);
  const held = w.espera(["paseo"], version);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    api.last().line(ev("ADDED", { metadata: { name: "rota", resourceVersion: "2" }, spec: {}, status: { resources: 5 } }));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  api.last().line(ev("ADDED", app("paseo", "3")));
  assert.equal((await held).apps.paseo!.health, "Healthy");
  w.cierra();
});

test("appWatch with Flux: one watch per resource; a resource the cluster does not serve is absent and never retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = fakeApi();
  const w = appWatch(api.open, 5_000);
  assert.deepEqual(api.opened.map((o) => o.path.split("/")[2]).sort(), ["argoproj.io", "helm.toolkit.fluxcd.io", "kustomize.toolkit.fluxcd.io"]);
  const ks = { metadata: { name: "apps", namespace: "flux-system", resourceVersion: "1" },
    status: { conditions: [{ type: "Ready", status: "True", reason: "ReconciliationSucceeded" }] } };
  api.of("argoproj").line(initialEnd("1"));
  api.of("kustomize").line(ev("ADDED", ks));
  api.of("kustomize").line(initialEnd("2"));
  api.of("helm").closed("Error from server (NotFound): the server could not find the requested resource");
  const r = await w.espera(["ks/flux-system/apps", "hr/devopsai/api", "paseo"], 0);
  assert.equal(r.apps["ks/flux-system/apps"]!.sync, "Ready");
  assert.equal(r.apps["hr/devopsai/api"]!.error, "Flux no está en este clúster");
  assert.equal(r.apps.paseo!.error, "paseo no existe en ArgoCD (argocd)");
  assert.deepEqual([...(await w.index())], ["ks/flux-system/apps"]);
  t.mock.timers.tick(60_000);
  assert.equal(api.opened.length, 3, "no retry for a resource that does not exist");

  const { version } = r;
  const held = w.espera(["ks/flux-system/apps"], version);
  api.of("kustomize").line(ev("MODIFIED", { ...ks, metadata: { ...ks.metadata, resourceVersion: "3" },
    status: { conditions: [{ type: "Ready", status: "False", reason: "HealthCheckFailed", message: "timeout" }] } }));
  const changed = await held;
  assert.equal(changed.apps["ks/flux-system/apps"]!.health, "HealthCheckFailed");
  w.cierra();
});
