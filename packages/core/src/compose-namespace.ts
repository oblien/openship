/**
 * Compose `network_mode` / `pid` — the Linux namespaces a service SHARES with a
 * sibling instead of getting its own.
 *
 * This is the single authority on which values openship accepts and what they
 * mean, imported by the compose parser (import), the CLI sync mapper, the deploy
 * ordering pass, and the Docker runtime. A second spelling of these rules is how
 * a service ends up stored with a mode the runtime then can't honor — the exact
 * shape of the bug this module exists to close (#533).
 *
 * WHAT WE ACCEPT, AND WHY NOT `host`
 * ----------------------------------
 * `service:<name>` and `container:<id>` are namespace SHARING: the dependent
 * container gets no interface/pid-space of its own and lives inside another
 * container's. That composes with openship's model — the provider is still a
 * normal service on the project network, still behind the edge, still a row we
 * own — so we resolve the reference and apply it.
 *
 * `host` is not sharing, it's an escape. A host-netns container binds host
 * interfaces directly (Docker ignores PortBindings entirely), which voids the
 * loopback-only-behind-the-edge invariant every other workload upholds, and it
 * reaches every 127.0.0.1 service on the box — including openship's own API,
 * which grants zero-auth to loopback callers. That is a privilege grant arriving
 * through a compose file, on a path with no operator decision in it. Refused at
 * import with the field named, rather than applied or silently dropped.
 *
 * Pure string logic, no dependencies.
 */

/** A namespace reference, once validated. */
export type ComposeNamespaceRef =
  /** `none` — no network at all (network_mode only). */
  | { kind: "none" }
  /** `service:<name>` — share a sibling IN THIS STACK. Resolved to a container
   *  id at deploy, which is why it also implies a start-order dependency. */
  | { kind: "service"; service: string }
  /** `container:<id>` — share a container by id/name. Not resolvable to a stack
   *  member, so it is passed through and validated by Docker at create. */
  | { kind: "container"; container: string };

/** Which compose key a value came from — only used to word errors. */
export type ComposeNamespaceField = "network_mode" | "pid";

export type ComposeNamespaceParse =
  | { ok: true; ref: ComposeNamespaceRef; value: string }
  | { ok: false; reason: string };

/** Docker accepts a 12- or 64-char hex id, or a container NAME. */
const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Compose service names are DNS-ish; mirrors what the parser keys services by. */
const SERVICE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Validate one `network_mode` / `pid` value.
 *
 * Returns a `reason` rather than throwing: every caller is INSPECTING a file the
 * user hasn't had a chance to fix yet (import scan, migration adopt, CLI sync),
 * and the parser's contract is that only unusable YAML throws (#472). The reason
 * is operator-facing text — it names the field and the value.
 */
export function parseComposeNamespace(
  raw: unknown,
  field: ComposeNamespaceField,
): ComposeNamespaceParse | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    return { ok: false, reason: `${field} must be a string, got ${typeof raw}.` };
  }
  const value = raw.trim();
  if (!value) return undefined;

  if (value === "host") {
    return {
      ok: false,
      reason:
        `${field}: host is not supported. A host-namespace container bypasses the ` +
        `edge (its ports bind host interfaces directly) and can reach every ` +
        `loopback service on the machine, including Openship's own API. Share a ` +
        `sibling's namespace instead (${field}: service:<name>), or run this ` +
        `workload outside the stack.`,
    };
  }

  if (field === "network_mode") {
    if (value === "none") return { ok: true, ref: { kind: "none" }, value };
    // `bridge` / `default` / a user-defined network name all mean "put me on a
    // network openship doesn't manage". The project network IS the default here,
    // so treat the compose default as already satisfied rather than an error.
    if (value === "bridge" || value === "default") return undefined;
  }

  const serviceRef = value.startsWith("service:") ? value.slice("service:".length) : undefined;
  if (serviceRef !== undefined) {
    if (!SERVICE_REF.test(serviceRef)) {
      return { ok: false, reason: `${field}: "${value}" is not a valid service reference.` };
    }
    return { ok: true, ref: { kind: "service", service: serviceRef }, value };
  }

  const containerRef = value.startsWith("container:") ? value.slice("container:".length) : undefined;
  if (containerRef !== undefined) {
    if (!CONTAINER_REF.test(containerRef)) {
      return { ok: false, reason: `${field}: "${value}" is not a valid container reference.` };
    }
    return { ok: true, ref: { kind: "container", container: containerRef }, value };
  }

  return {
    ok: false,
    reason:
      `${field}: "${value}" is not supported. Openship accepts ` +
      (field === "network_mode" ? `"none", ` : "") +
      `"service:<name>" (a service in this stack) and "container:<id>".`,
  };
}

/** Re-read a stored `advanced.networkMode` / `advanced.pidMode`. */
export function composeNamespaceRef(
  value: string | undefined | null,
  field: ComposeNamespaceField,
): ComposeNamespaceRef | undefined {
  const parsed = parseComposeNamespace(value, field);
  return parsed?.ok ? parsed.ref : undefined;
}

/**
 * The sibling service this value depends on, if any — the one piece of the
 * namespace story the deploy ORDER has to know. A namespace provider must be
 * running before its dependent is created (Docker resolves `container:<id>` at
 * create time), so this feeds both the topological sort and the
 * "dependency didn't come up" guard, exactly like `depends_on`.
 */
export function composeNamespaceDependencies(
  advanced: { networkMode?: string; pidMode?: string } | null | undefined,
): string[] {
  const deps: string[] = [];
  for (const [value, field] of [
    [advanced?.networkMode, "network_mode"],
    [advanced?.pidMode, "pid"],
  ] as const) {
    const ref = composeNamespaceRef(value, field);
    if (ref?.kind === "service" && !deps.includes(ref.service)) deps.push(ref.service);
  }
  return deps;
}

/**
 * Does this service own a network endpoint of its own — an address something could
 * be routed to?
 *
 * ANY declared network mode means no: `service:`/`container:` puts the interfaces
 * under another container, and `none` means there are none. That single answer has
 * to drive both the runtime (which must omit the port bindings, the network
 * endpoint, and the alias, because Docker rejects them) and the deploy path (which
 * must not allocate a host port or register a route that could never resolve).
 *
 * Deliberately one predicate rather than two: an earlier draft asked "does it SHARE
 * a namespace" in the deploy path and "does it have an endpoint" in the runtime,
 * which agreed for `service:`/`container:` and disagreed for `none` — so a
 * `network_mode: none` service got a pinned loopback port and a live route pointing
 * at a container that publishes nothing. Same failure shape as the two mount folds
 * in compose-spec.ts, and the same remedy.
 *
 * Takes the RESOLVED mode (`container:<id>` / `none` / undefined) rather than the
 * stored compose value, so it reads exactly what reached the daemon.
 */
export function ownsNetworkEndpoint(resolvedNetworkMode: string | undefined | null): boolean {
  return !resolvedNetworkMode;
}
