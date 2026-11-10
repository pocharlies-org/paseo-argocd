# paseo-argocd

A Paseo plugin that shows, next to the composer's other pills, the ArgoCD deployment of the application an agent is
working on: the helm mark tinted by the state and the app name — `paseo ◐` (syncing or rolling out), `paseo ✓`
(Synced + Healthy), `paseo ✗` (degraded or failed operation), `paseo · out` (OutOfSync at rest), `paseo ?` (unreadable).
Tap it for sync, health, the operation's phase, message and live duration, the revision, the resources that are not ok,
and a link to the ArgoCD UI.

- The app is the last one the agent's conversation names: `argocd app sync paseo`, `ESPERA: argocd paseo`,
  `kubectl get application paseo -n argocd`, the UI link, or — when no app is named — the last mention of a deploy repo
  that belongs to exactly one app (`k8s-paseo-pocharlies` → `paseo`). Repos shared by several apps (`dgx-infra`) are not
  mapped. It works in workspaces that are not a git checkout.
- The daemon reads the cluster with its own kubeconfig (`kubectl get application -n argocd`), so no credential reaches
  the client. It needs `kubectl` and a kubeconfig on the daemon's host.
- Polls every 10 s while the deployment moves, every 2 min once settled; one read per app every 15 s at most, whatever
  the clients.

## Install

```sh
paseo plugin add git:pocharlies-org/paseo-argocd
```

## Development

`npm ci --ignore-scripts && npm run typecheck && npm test`. For a live loop, install the directory:
`paseo plugin add ~/src/paseo-argocd && paseo plugin reload paseo-argocd`.

MIT licensed.
