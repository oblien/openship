/**
 * DMARC Aggregate Report Types (RFC 7489 / RFC 9990).
 */

export type DmarcAlignmentMode = "r" | "s"; // "r" = relaxed, "s" = strict

export type DmarcDisposition = "none" | "quarantine" | "reject";

export type DmarcDkimResult =
  | "pass"
  | "fail"
  | "neutral"
  | "policy"
  | "nxdomain"
  | "temperror"
  | "permerror";

export type DmarcSpfResult =
  | "none"
  | "neutral"
  | "pass"
  | "fail"
  | "softfail"
  | "temperror"
  | "permerror";

export interface DmarcReportMetadata {
  /** Reporting organization name (e.g. "google.com", "Yahoo! Inc."). */
  orgName: string;
  /** Contact email for reporting organization. */
  email: string;
  /** Additional contact URL or info. */
  extraContactInfo?: string;
  /** Unique report ID from reporting organization (preserved as opaque string). */
  reportId: string;
  /** Time window covered by the report. */
  dateRange: {
    begin: Date;
    end: Date;
  };
  /** Optional error messages reported by the receiver. */
  errors?: string[];
}

export interface DmarcPolicyPublished {
  /** Domain for which the DMARC policy was published. */
  domain: string;
  /** DKIM alignment mode: 'r' (relaxed) or 's' (strict). Default 'r'. */
  adkim?: DmarcAlignmentMode;
  /** SPF alignment mode: 'r' (relaxed) or 's' (strict). Default 'r'. */
  aspf?: DmarcAlignmentMode;
  /** Published policy: 'none', 'quarantine', or 'reject'. */
  p: DmarcDisposition | string;
  /** Subdomain policy. */
  sp?: DmarcDisposition | string;
  /** Percentage of messages subjected to policy (0-100). */
  pct?: number;
  /** Failure reporting options. */
  fo?: string;
  /** RFC 9990: Non-existent domain policy. */
  np?: string;
}

export interface DmarcPolicyOverrideReason {
  type: string;
  comment?: string;
}

export interface DmarcDkimAuthResult {
  domain: string;
  result: DmarcDkimResult;
  selector?: string;
  humanResult?: string;
}

export interface DmarcSpfAuthResult {
  domain: string;
  result: DmarcSpfResult;
  scope?: string;
}

export interface DmarcRecord {
  row: {
    /** Source IPv4 or IPv6 address sending the messages. */
    sourceIp: string;
    /** Message count in this batch. */
    count: number;
    /** Receiver's policy evaluation results. */
    policyEvaluated: {
      disposition: DmarcDisposition;
      dkim: "pass" | "fail";
      spf: "pass" | "fail";
      reasons?: DmarcPolicyOverrideReason[];
    };
  };
  identifiers: {
    /** The domain in the RFC5322.From header. */
    headerFrom: string;
    /** Envelope To destination domain/mailbox if reported. */
    envelopeTo?: string;
    /** Envelope From domain if reported. */
    envelopeFrom?: string;
  };
  authResults: {
    dkim: DmarcDkimAuthResult[];
    spf: DmarcSpfAuthResult[];
  };
}

export interface DmarcAggregateReport {
  version?: string;
  metadata: DmarcReportMetadata;
  policyPublished: DmarcPolicyPublished;
  records: DmarcRecord[];
}

export interface DmarcExtractionResult {
  filename?: string;
  rawXml: string;
  report: DmarcAggregateReport;
}

export class DmarcParseError extends Error {
  readonly code = "DMARC_PARSE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "DmarcParseError";
  }
}

export class DmarcSecurityError extends Error {
  readonly code = "DMARC_SECURITY_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "DmarcSecurityError";
  }
}
