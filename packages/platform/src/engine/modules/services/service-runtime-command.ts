import { resolveComposeCommandTemplate, type ComposeAdvanced } from "@repo/core";

/** Resolve both deployment command representations from the same final env. */
export function serviceRuntimeCommand(service: {
  startCommand?: string | null;
  command?: string | null;
  commandArgv?: string[] | null;
  advanced?: ComposeAdvanced | null;
}, environment: Record<string, string>) {
  if (service.startCommand) return { command: service.startCommand, commandArgv: null };
  if (service.advanced?.commandTemplate)
    return resolveComposeCommandTemplate(service.advanced.commandTemplate, environment);
  return { command: service.command ?? undefined, commandArgv: service.commandArgv ?? null };
}
