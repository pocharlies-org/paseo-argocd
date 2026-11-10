# paseo-argocd

A Paseo plugin that shows, next to the composer's other pills, the ArgoCD deployment of the application an agent is
working on: the helm mark tinted by the state and the app name — `paseo ◐` (syncing or rolling out), `paseo ✓`
(Synced + Healthy), `paseo ✗` (degraded or failed operation), `paseo · out` (OutOfSync at rest), `paseo ?` (unreadable).
Tap it for sync, health, the operation's phase, message and live duration, the revision, the resources that are not ok,
and a link to the ArgoCD UI.

- The app is the last one the session itself named while deploying or watching: `argocd app sync paseo`,
  `ESPERA: argocd paseo`, `kubectl get application paseo -n argocd` or the UI link, in the session's own messages or
  shell commands. Nothing is inferred: tool results (the text of a skill, the output of kubectl), reasoning and repo
  names alone never link an app — the pill appears only for what the session waits on or deploys. It works in
  workspaces that are not a git checkout.
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
