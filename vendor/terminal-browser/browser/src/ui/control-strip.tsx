import { Box, Text } from "pixel-react";
import type { AgentControlSnapshot } from "../agent/control";
import { Icon } from "./icons";
import type { Theme } from "./theme";

export function controlLabel(state: string): string {
  switch (state) {
    case "agent": return "Agent";
    case "human": return "Human";
    case "shared": return "Shared";
    case "paused": return "Paused";
    default: return "Unknown";
  }
}

/** Keep control visible in browser chrome, outside the captured page. */
export function ControlStrip({ control, detail, compact, rem, theme, openMenu, openControl }: {
  control: AgentControlSnapshot;
  detail?: string;
  compact: boolean;
  rem: number;
  theme: Theme;
  openMenu(): void;
  openControl(): void;
}) {
  const color = control.state === "human" ? theme.yellow
    : control.state === "paused" ? theme.muted : theme.accent;
  const suffix = detail || (control.busy ? "busy" : "");
  const label = `${controlLabel(control.state)}${!compact && suffix ? ` · ${suffix}` : ""}`;
  return (
    <Box style={{ alignItems: "center", gap: rem * 0.2, flexShrink: 0 }}>
      <Box
        id="browser-control"
        style={{
          width: rem * (compact ? 4.5 : 11),
          height: rem * 1.6,
          alignItems: "center",
          justifyContent: "center",
          padding: { left: rem * 0.4, right: rem * 0.4 },
          border: { width: 1, color },
          cornerRadius: rem * 0.35,
          hoverBackground: theme.hover,
          overflow: "hidden",
        }}
        onClick={openControl}
      >
        <Text style={{ fontSize: rem * 0.72, color, wrap: false, selectable: false, overflow: "hidden" }}>
          {label}
        </Text>
      </Box>
      <Box
        id="browser-menu"
        style={{
          width: rem * 1.5,
          height: rem * 1.6,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.3,
          hoverBackground: theme.hover,
          flexShrink: 0,
        }}
        onClick={openMenu}
      >
        <Icon icon="more" size={rem * 1.15} color={theme.fg} />
      </Box>
    </Box>
  );
}
