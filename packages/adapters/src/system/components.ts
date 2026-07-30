import type { SystemComponentDefinition } from "./types";

export const SYSTEM_COMPONENTS: SystemComponentDefinition[] = [
  {
    name: "docker",
    label: "Docker",
    description: "Container runtime for deployments",
    installable: true,
    category: "core",
  },
  {
    name: "git",
    label: "Git",
    description: "Version control for source code",
    installable: true,
    category: "core",
  },
  {
    // ONE component for the edge, because it is ONE artifact: the openship-edge
    // image. OpenResty, its Lua, and certbot all ship inside it — they were three
    // rows in this list for a thing that is installed, checked, and removed as a
    // unit, and neither "openresty" nor "certbot" was independently installable
    // on a converted box.
    name: "edge",
    label: "Edge",
    description: "Routing + TLS — the openship-edge container (OpenResty, Lua, certbot)",
    installable: true,
    category: "infrastructure",
  },
  {
    name: "rsync",
    label: "rsync",
    description: "Fast directory sync for remote local-build transfers",
    installable: true,
    category: "infrastructure",
  },
];

export const SYSTEM_COMPONENTS_BY_NAME = new Map(
  SYSTEM_COMPONENTS.map((component) => [component.name, component]),
);


export function getSystemComponentDefinition(
  name: string,
): SystemComponentDefinition {
  return (
    SYSTEM_COMPONENTS_BY_NAME.get(name) ?? {
      name,
      label: name,
      description: `${name} component`,
      installable: false,
      category: "infrastructure" as const,
    }
  );
}