import type { IconName } from "@repo/ui/icons";
export type ServerTab =
  | "overview"
  | "migrations"
  | "components"
  | "github"
  | "security"
  | "ports"
  | "terminal";
/** Connected self-hosted server tools. Managed pools use Resources instead. */
export const SERVER_TABS: { key: ServerTab; icon: IconName; desktopOnly?: boolean }[] = [
  { key: "overview", icon: "grid" },
  { key: "migrations", icon: "migration" },
  { key: "components", icon: "server-settings" },
  { key: "github", icon: "git-branch" },
  { key: "security", icon: "shield" },
  { key: "ports", icon: "port-forwarding", desktopOnly: true },
  { key: "terminal", icon: "terminal" },
];
