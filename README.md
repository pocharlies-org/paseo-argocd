# paseo-argocd

A Paseo plugin that shows, next to the composer's other pills, the deployment an agent is working on — an ArgoCD
application or a Flux Kustomization or HelmRelease. For ArgoCD: the helm mark tinted by the state, the app name and both axes — `paseo ✓ Synced·Healthy`,
`paseo ◐ Synced·Progressing` (syncing or rolling out), `paseo ✗ Synced·Degraded` (degraded or failed operation),
`paseo · OutOfSync·Healthy` (at rest), `paseo ?` (unreadable).
Tap it for the Spanish reading of the same state, the operation's phase, message and live duration, the revision, the
resources that are not ok, and a link to the ArgoCD UI.
For Flux, in Flux's own words: `apps ✓ Ready`, `apps ◐ Progressing` (reconciling), `apps ✗ HealthCheckFailed` (not ready,
with its reason), `apps · Suspended`; the popover adds the applied revision and Flux's message.

- The app is the last one the session itself named while deploying or watching: `argocd app sync paseo`,
  `ESPERA: argocd paseo`, `kubectl get application paseo -n argocd` or the UI link, in the session's own messages or
  shell commands. Nothing is inferred: tool results (the text of a skill, the output of kubectl), reasoning and repo
  names alone never link an app — the pill appears only for what the session waits on or deploys. It works in
  workspaces that are not a git checkout. Flux objects are named the same way, by the session's own commands:
  `flux reconcile|get|suspend|resume|diff|tree kustomization|ks|helmrelease|hr <name>` or
  `kubectl get|describe|wait kustomization|ks|helmrelease|hr <name>`, with `-n <namespace>` (`flux-system` without it).
- The daemon reads the cluster with its own kubeconfig, so no credential reaches the client. It needs `kubectl` and a
  kubeconfig on the daemon's host that may `watch` Applications in `argocd` and, for Flux, Kustomizations and
  HelmReleases in every namespace. A cluster without Flux (or without its helm-controller) is fine: that resource is
  simply absent, and is not retried.
- The UI link needs your ArgoCD base URL: set `ARGOCD_UI` on the daemon (e.g. `https://argocd.example.com`) or put it in
  the first line of `~/.config/paseo-argocd/ui`. Without it the popover simply shows no link.
- If you run the Control Nexus dashboard, the popover's main link goes to its Kubernetes view (`<base>/services?mode=argocd&app=<app>`):
  set `PASEO_ARGOCD_PANEL` (e.g. `https://dgx.example.com`) or the first line of `~/.config/paseo-argocd/panel`. Without it
  the popover links only to the ArgoCD UI.
- Nothing polls. The daemon keeps one Kubernetes watch per resource (Applications, Kustomizations, HelmReleases), whatever the clients, and each client holds
  one `argocd.watch` call for all the apps its pills show, which the daemon answers only when one of them changes what
  its pill shows (a reconcile that changes nothing wakes nobody).

## Install

```sh
paseo plugin add git:pocharlies-org/paseo-argocd
```

## Development

`npm ci --ignore-scripts && npm run typecheck && npm test`. For a live loop, install the directory:
`paseo plugin add ~/src/paseo-argocd && paseo plugin reload paseo-argocd`.

MIT licensed.
