/**
 * Outbound relay (smarthost) providers — the DECLARATIVE half of "send through
 * someone else's SMTP while still receiving here".
 *
 * This exists because the relay code used to carry a `provider: "ses" | "custom"`
 * union, which is not a provider identity — it's "does this one need special
 * casing". Everything that wasn't SES collapsed to `"custom"`, so SendGrid,
 * Mailgun and Postmark lost their identity the moment they were saved: no SPF
 * include, no round-trip in the UI, and a new provider meant editing an `if` in
 * the service, the DNS builder, and the scanner.
 *
 * So the per-provider FACTS live here as data, and the service reads them:
 *   - how the SMTP host is derived (fixed, or regional template)
 *   - which submission port to default to
 *   - the SPF `include:` every relayed domain must publish
 *   - whether the provider issues DKIM CNAMEs you paste from its console
 *   - whether it supports a custom MAIL FROM (bounce) domain, and its records
 *
 * Pure + shared (`@repo/core`) so the API and the dashboard agree on one table.
 * UI-only copy — logos, "what to paste" hints — stays in the dashboard catalog
 * (`apps/dashboard/src/lib/mail-providers.ts`), which is also the IMAP side.
 *
 * `spfInclude` is deliberately BLANK where the token is account- or
 * region-specific (Resend, Oracle). Publishing a guessed include is worse than
 * publishing none: the DNS check goes green against a mechanism the provider
 * doesn't honor, and the mail still fails SPF. Those providers surface a manual
 * field instead.
 */

export interface RelayProviderSpec {
  readonly id: string;
  readonly label: string;
  /**
   * SMTP host. `{region}` is substituted when `regional`. Absent = the operator
   * supplies the host (`custom`).
   */
  readonly hostTemplate?: string;
  /** Region is required and substituted into `hostTemplate`. */
  readonly regional?: boolean;
  /** Submission port to prefill. */
  readonly defaultPort: number;
  /**
   * SPF mechanism every relayed domain must publish for the provider's hosts to
   * pass SPF. Blank when it's account/region-specific — see the file header.
   */
  readonly spfInclude?: string;
  /** SASL username the provider mandates (prefilled, still editable). */
  readonly username?: string;
  /**
   * The provider issues DKIM CNAMEs (domain authentication) you paste from its
   * console. We sign locally with amavis too, so these are the provider's
   * identity records, not our keys.
   */
  readonly providerDkim?: boolean;
  /**
   * Custom MAIL FROM / bounce domain support and the records it needs.
   * `{region}` is substituted in `mxTemplate`.
   */
  readonly mailFrom?: { readonly mxTemplate: string; readonly spf: string };
}

export const RELAY_PROVIDERS = [
  {
    id: "ses",
    label: "Amazon SES",
    hostTemplate: "email-smtp.{region}.amazonaws.com",
    regional: true,
    defaultPort: 587,
    spfInclude: "include:amazonses.com",
    providerDkim: true,
    mailFrom: {
      mxTemplate: "feedback-smtp.{region}.amazonaws.com",
      spf: "v=spf1 include:amazonses.com ~all",
    },
  },
  {
    id: "sendgrid",
    label: "SendGrid",
    hostTemplate: "smtp.sendgrid.net",
    defaultPort: 587,
    spfInclude: "include:sendgrid.net",
    username: "apikey",
    providerDkim: true,
  },
  {
    id: "mailgun",
    label: "Mailgun",
    hostTemplate: "smtp.mailgun.org",
    defaultPort: 587,
    spfInclude: "include:mailgun.org",
    providerDkim: true,
  },
  {
    id: "postmark",
    label: "Postmark",
    hostTemplate: "smtp.postmarkapp.com",
    defaultPort: 587,
    spfInclude: "include:spf.mtasv.net",
    providerDkim: true,
  },
  {
    id: "resend",
    // Resend rides SES, but the verified-domain records it hands out are
    // per-account — don't assume the SES include.
    label: "Resend",
    hostTemplate: "smtp.resend.com",
    defaultPort: 587,
    username: "resend",
    providerDkim: true,
  },
  {
    id: "oracle",
    // OCI Email Delivery's SPF include is region-scoped
    // (rp / eu.rp / ap.rp .oracleemaildelivery.com) — the operator pastes theirs.
    label: "Oracle Cloud",
    hostTemplate: "smtp.email.{region}.oci.oraclecloud.com",
    regional: true,
    defaultPort: 587,
    providerDkim: true,
  },
  {
    id: "custom",
    label: "Custom SMTP",
    defaultPort: 587,
  },
] as const satisfies readonly RelayProviderSpec[];

export type RelayProviderId = (typeof RELAY_PROVIDERS)[number]["id"];

export const RELAY_PROVIDER_IDS = RELAY_PROVIDERS.map((p) => p.id) as readonly RelayProviderId[];

/** Is this a provider we know? Guards persisted/user input before it's trusted. */
export function isRelayProviderId(id: unknown): id is RelayProviderId {
  return typeof id === "string" && (RELAY_PROVIDER_IDS as readonly string[]).includes(id);
}

/**
 * The spec for an id. Unknown ids (state written by a newer version, or a
 * hand-edited file) fall back to `custom` — which needs an explicit host, so the
 * failure is a clear validation error instead of mail silently going nowhere.
 *
 * The return narrows `id` to `RelayProviderId` (the authoring interface leaves it
 * `string`), so `relayProvider(x).id` can be handed straight back to an API that
 * takes a provider id — resolving an id is also how you validate one.
 */
export function relayProvider(id: string | undefined): RelayProviderSpec & { id: RelayProviderId } {
  return RELAY_PROVIDERS.find((p) => p.id === id) ?? RELAY_PROVIDERS[RELAY_PROVIDERS.length - 1];
}

/**
 * The effective SMTP host: regional providers derive it from the region, fixed
 * providers use their template unless the operator overrode it (Mailgun's EU
 * region, a provider's alternate endpoint), and `custom` is operator-supplied.
 * Returns null when the input can't produce one — the caller turns that into the
 * user-facing error, since only it knows which field to blame.
 */
export function resolveRelayHost(input: {
  provider: string;
  host?: string;
  region?: string;
}): string | null {
  const spec = relayProvider(input.provider);
  const explicit = input.host?.trim();
  if (spec.regional) {
    const region = input.region?.trim();
    if (!region || !spec.hostTemplate) return null;
    return spec.hostTemplate.replace("{region}", region);
  }
  if (explicit) return explicit;
  return spec.hostTemplate ?? null;
}

/**
 * The SPF include to publish: the operator's override first (the only option for
 * providers whose token is account-specific), else the provider's known token,
 * else none.
 */
export function relayProviderSpfInclude(input: {
  provider: string;
  spfInclude?: string;
}): string | undefined {
  const explicit = input.spfInclude?.trim();
  if (explicit) return explicit;
  return relayProvider(input.provider).spfInclude;
}

/** MAIL FROM (bounce domain) records for one relayed domain, if supported. */
export function relayMailFromRecords(input: {
  provider: string;
  region?: string;
  mailFromDomain?: string;
}): { mx: string; spf: string } | null {
  const spec = relayProvider(input.provider);
  const domain = input.mailFromDomain?.trim();
  if (!spec.mailFrom || !domain) return null;
  const region = input.region?.trim();
  if (spec.mailFrom.mxTemplate.includes("{region}") && !region) return null;
  return {
    mx: spec.mailFrom.mxTemplate.replace("{region}", region ?? ""),
    spf: spec.mailFrom.spf,
  };
}
