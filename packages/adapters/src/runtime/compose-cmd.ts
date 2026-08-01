/**
 * Resolve a compose service's container `Cmd` (#332).
 *
 * docker-compose semantics: a `command` overrides the image CMD as ARGV and
 * leaves the ENTRYPOINT intact — there is no implicit `sh -c`. `commandArgv` is
 * the structured argv and is authoritative when present (`[]` clears the image
 * CMD). Only a legacy row that has just the text `command` (no argv, parsed
 * before this fix) falls back to the old `["sh","-c",<string>]` wrap, so
 * existing shell-reliant deployments don't change until re-parsed.
 */
export function resolveComposeCmd(config: {
  commandArgv?: string[] | null;
  command?: string;
}): string[] | undefined {
  if (config.commandArgv != null) return config.commandArgv;
  return config.command ? ["sh", "-c", config.command] : undefined;
}
