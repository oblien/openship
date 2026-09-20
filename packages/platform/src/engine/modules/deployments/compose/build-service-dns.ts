import { stripVTControlCharacters } from "node:util";

/**
 * A build-time DNS error for a known project service needs different guidance
 * from a package-registry failure. Output is observed before Docker's renderer
 * trims or prefixes it: a transport chunk is not a complete line or hostname.
 *
 * This is advisory evidence. The caller adds it only after the runtime reports
 * a failed build, so a retried lookup cannot turn a successful build into a
 * failure. It does not establish the cause of unrelated timeouts or auth errors.
 */
export class ServiceBuildDnsDiagnostics {
  private readonly tails = new Map<string, string>();
  private hostname?: string;

  constructor(private readonly serviceNames: ReadonlySet<string>) {}

  observe(output: string, streamId = "default"): void {
    if (this.hostname) return;
    const rawText = (this.tails.get(streamId) ?? "") + output;
    const text = stripVTControlCharacters(rawText);
    // A delimiter is required. End-of-chunk cannot confirm "db": the next
    // chunk could be ".example.com". finish() supplies the end-of-stream boundary.
    for (const match of text.matchAll(
      /\bgetaddrinfo\s+ENOTFOUND\s+([a-zA-Z0-9_.-]+)(?=[\s"'`),;}\]])/g,
    )) {
      const hostname = match[1]!;
      if (!this.serviceNames.has(hostname)) continue;
      this.hostname = hostname;
      this.tails.clear();
      return;
    }

    // Only the unfinished line can contain a split marker/hostname. Bound its
    // size, and never copy it into the diagnostic: it may contain credentials.
    // Retain raw escapes: a color sequence can also span transport chunks.
    const lineStart = Math.max(rawText.lastIndexOf("\n"), rawText.lastIndexOf("\r")) + 1;
    const tail = rawText.slice(lineStart).slice(-2048);
    this.tails.delete(streamId);
    if (tail) {
      this.tails.set(streamId, tail);
      // BuildKit may have many vertices. Keep only the 64 most recent partial
      // streams so a noisy build cannot accumulate unbounded diagnostic state.
      if (this.tails.size > 64) this.tails.delete(this.tails.keys().next().value!);
    }
  }

  finish(finalError: string): string | undefined {
    for (const streamId of this.tails.keys()) this.observe("\n", streamId);
    this.observe(`${finalError}\n`, "final-error");
    this.tails.clear();
    if (!this.hostname) return;

    return (
      `Build output also reported getaddrinfo ENOTFOUND ${this.hostname}, a project service hostname. ` +
      "Docker builds do not automatically join the service network, even when the service is running; dependsOn only controls container startup. " +
      "Move connections needed only at runtime into a request handler or startup code. " +
      "For Next.js/Payload, check the route and its imports for top-level getPayload() calls; force-dynamic alone does not prevent module initialization. " +
      "If the build needs data, use a source reachable from the build environment. " +
      "See https://openship.io/docs/guides/compose-multi-service#database-access-during-a-nextjs-build"
    );
  }
}
