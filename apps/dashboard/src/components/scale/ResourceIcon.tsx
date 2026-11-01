import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import type { ResourceKind } from "./topology";

const icons: Record<ResourceKind, IconName> = {
  edge: "network",
  service: "window",
  postgres: "database",
  redis: "redis",
};
export function ResourceIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const Icon = icons[kind];
  return <UiIcon name={Icon} className={className} aria-hidden="true" />;
}
