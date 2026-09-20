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

/**
 * Resolve a compose service's container `Entrypoint` (#575) — the other half of
 * container shape, decided here so both halves live in one file.
 *
 * `undefined` means "say nothing", and the caller must then omit the key entirely
 * so Docker keeps the image's own ENTRYPOINT. An empty array is NOT that: compose
 * `entrypoint: []` / `entrypoint: ""` asks for the ENTRYPOINT to be CLEARED, and
 * Docker's create takes `Entrypoint: []` as exactly that. Collapsing the two is the
 * bug this exists to prevent — it kept the image's wrapper running and handed it the
 * operator's command as arguments, so the wrapper chose what ran.
 *
 * The parser already split a string form into argv (no implicit `sh -c`), so there
 * is nothing to interpret here beyond absent-vs-empty.
 */
export function resolveComposeEntrypoint(advanced?: {
  entrypoint?: string[] | null;
}): string[] | undefined {
  return advanced?.entrypoint ?? undefined;
}
