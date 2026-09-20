import { Box, Database, Layers3, Network, type LucideIcon } from "lucide-react";
import type { ResourceKind } from "./topology";

const icons: Record<ResourceKind, LucideIcon> = {
  edge: Network,
  service: Box,
  postgres: Database,
  redis: Layers3,
};
export function ResourceIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const Icon = icons[kind];
  return <Icon className={className} aria-hidden="true" />;
}
