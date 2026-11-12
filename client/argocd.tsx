import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { GLYPH, deployState, type DeployState } from "../shared/argocd.ts";
import { argocdEntry, subscribeArgocd } from "./pills.ts";

function duration(start: string | null, end: string | null, now: number): string {
  if (!start) return "";
  const s = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const WORD: Record<string, string> = { Synced: "sincronizado", OutOfSync: "desincronizado", Healthy: "sano", Degraded: "degradado", Progressing: "desplegando" };

export function ArgocdPopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const c = theme.colors;
  const agentId = props.context === "agent" ? props.agentId : "";
  const [, setTick] = useState(0);
  useEffect(() => subscribeArgocd(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000); // the running operation's clock
    return () => clearInterval(t);
  }, []);
  const entry = argocdEntry(agentId);
  const stateOf = (s: DeployState) =>
    s === "success" ? c.statusSuccess : s === "failure" ? c.statusDanger : s === "pending" ? c.statusWarning : c.foregroundMuted;
  const muted = { color: c.foregroundMuted, fontSize: 12 };

  if (!entry) return <Text style={{ ...muted, padding: 12 }}>Sin despliegue de ArgoCD en esta conversación.</Text>;
  const { app, deploy } = entry;
  if (!deploy) return <Text style={{ ...muted, padding: 12 }}>Leyendo {app} en ArgoCD…</Text>;
  const s = deployState(deploy);
  const now = Date.now();

  return (
    <View style={{ padding: 12, gap: 8, minWidth: 320, maxWidth: 480 }}>
      <View style={{ gap: 2 }}>
        <Text style={muted}>ArgoCD · argocd/{app}</Text>
        {deploy.panel || deploy.url ? (
          <ExternalLink href={deploy.panel || deploy.url}>
            <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{app}</Text>
          </ExternalLink>
        ) : null}
        {deploy.panel && deploy.url ? (
          <ExternalLink href={deploy.url}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Abrir en ArgoCD</Text>
          </ExternalLink>
        ) : null}
      </View>
      {deploy.error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{deploy.error}</Text> : null}
      {!deploy.error ? (
        <>
          <Text style={{ color: stateOf(s), fontSize: 13, fontWeight: "600" }}>
            {GLYPH[s]} {WORD[deploy.sync] ?? deploy.sync.toLowerCase()} · {WORD[deploy.health] ?? deploy.health.toLowerCase()}
            {deploy.operation ? ` · operación ${deploy.operation.toLowerCase()}` : ""}
          </Text>
          <Text style={muted}>
            {[deploy.revision ? deploy.revision.slice(0, 7) : "", duration(deploy.startedAt, deploy.completedAt, now)]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {deploy.message ? (
            <Text numberOfLines={3} style={{ color: s === "failure" ? c.statusDanger : c.foregroundMuted, fontSize: 12 }}>
              {deploy.message}
            </Text>
          ) : null}
        </>
      ) : null}
      {deploy.resources.length ? (
        <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 6 }}>
          {deploy.resources.map((r, i) => (
            <View key={i} style={{ gap: 1 }}>
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13 }}>
                {r.key}
              </Text>
              <Text numberOfLines={2} style={muted}>
                {[r.sync, r.health, r.message].filter(Boolean).join(" · ").toLowerCase()}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
