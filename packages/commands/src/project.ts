/** Syntax only. Clients retain their authenticated SDK/MCP execution and confirmations. */
export const PROJECT_COMMANDS = {
  list: {
    name: "list",
    argument: null,
    description: "List projects in the active organization",
    chat: "projects",
  },
  get: {
    name: "get",
    argument: "project-id",
    description: "Show a project and its deployment status",
    chat: "status",
  },
  logs: { name: "logs", argument: "project-id", description: "View project logs", chat: "logs" },
  redeploy: {
    name: "redeploy",
    argument: "project-id",
    description: "Redeploy the project's active deployment from the latest source",
    chat: "redeploy",
  },
  restart: {
    name: "restart",
    argument: "project-id",
    description: "Restart the project's active deployment",
    chat: "restart",
  },
} as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[keyof typeof PROJECT_COMMANDS];
export const validCommandId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Structural adapter: this package does not import Commander or load a CLI executable. */
export function defineProjectCommand<
  T extends {
    name(value: string): unknown;
    description(value: string): unknown;
    argument(name: string, description: string, parser: (value: string) => string): unknown;
  },
>(command: T, definition: ProjectCommand): T {
  command.name(definition.name);
  command.description(definition.description);
  if (definition.argument)
    command.argument("<id>", "Project ID", (value) => {
      if (!validCommandId(value)) throw new Error("Enter a valid project ID.");
      return value;
    });
  return command;
}

export function projectCommandUsage(command: ProjectCommand) {
  return `project ${command.name}${command.argument ? ` <${command.argument}>` : ""}`;
}
