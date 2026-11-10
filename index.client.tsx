import type { PluginButtonIcon, PluginClientContext } from "@getpaseo/plugin/client";
import { ArgocdPopover } from "./client/argocd";
import { registerArgocdPills } from "./client/pills";
import type { Tone } from "./shared/argocd";

// The helm mark (Argo, the ship's steerage), tinted with the deployment's colour: the pill API colours no label, so the
// logo carries it. `{ svg }` icons are accepted by the host since 0.15; the pinned 0.11.2 types only know names and
// components. shortcut: <cast to the 0.11.2 types>, <drop it when @getpaseo/plugin is bumped>
const FILL: Record<NonNullable<Tone>, string> = { pending: "#E3B341", failure: "#F85149", success: "#3FB950" };
const IDLE = "#EF7B4D"; // Argo CD's own orange

const icon = (tone: Tone) => {
  const colour = tone ? FILL[tone] : IDLE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round">` +
    `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/>` +
    `<line x1="12" y1="3" x2="12" y2="8.8"/><line x1="4.2" y1="16.5" x2="9.2" y2="13.6"/><line x1="19.8" y1="16.5" x2="14.8" y2="13.6"/></svg>`;
  return { svg } as unknown as PluginButtonIcon;
};

export default function contribute(client: PluginClientContext) {
  return registerArgocdPills(client, ArgocdPopover, icon);
}
