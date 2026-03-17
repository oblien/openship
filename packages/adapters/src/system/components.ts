import type { SystemComponentDefinition } from "./types";

export const SYSTEM_COMPONENTS: SystemComponentDefinition[] = [
  {
    name: "docker",
    label: "Docker",
    description: "Container runtime for deployments",
    installable: true,
  },
  {
    name: "traefik",
    label: "Traefik",
    description: "Reverse proxy and SSL certificates",
    installable: true,
  },
  {
    name: "git",
    label: "Git",
    description: "Version control for source code",
    installable: true,
  },
  {
    name: "node",
    label: "Node.js",
    description: "JavaScript runtime for build and app tasks",
    installable: true,
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
    }
  );
}