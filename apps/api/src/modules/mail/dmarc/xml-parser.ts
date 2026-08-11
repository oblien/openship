import {
  type DmarcAggregateReport,
  type DmarcAlignmentMode,
  type DmarcDisposition,
  type DmarcDkimResult,
  type DmarcPolicyOverrideReason,
  type DmarcRecord,
  type DmarcSpfResult,
  DmarcParseError,
  DmarcSecurityError,
} from "./types";

interface XmlNode {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Simple, safe, non-evaluating XML tokenizer & tree builder. */
function parseXmlTree(xml: string): XmlNode {
  // ── XXE and DTD security checks ──
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new DmarcSecurityError("XML contains disallowed DOCTYPE or ENTITY declaration.");
  }

  // Strip comments
  let sanitized = xml.replace(/<!--[\s\S]*?-->/g, "");
  // Strip XML processing instructions
  sanitized = sanitized.replace(/<\?[\s\S]*?\?>/g, "");

  const root: XmlNode = { tag: "#root", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];

  const tagRegex = /<(\/)?([a-zA-Z0-9_\-:]+)([\s\S]*?)(\/)?>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sanitized)) !== null) {
    const [fullMatch, isClosing, tagName, attrString, isSelfClosing, cdata, textContent] = match;

    const current = stack[stack.length - 1];
    if (!current) break;

    if (cdata !== undefined) {
      current.text += cdata;
    } else if (textContent !== undefined) {
      const trimmed = textContent.trim();
      if (trimmed) {
        current.text += (current.text ? " " : "") + decodeXmlEntities(trimmed);
      }
    } else if (tagName) {
      if (isClosing) {
        if (stack.length > 1 && current.tag.toLowerCase() === tagName.toLowerCase()) {
          stack.pop();
        }
      } else {
        const attributes = parseAttributes(attrString || "");
        const newNode: XmlNode = {
          tag: tagName,
          attributes,
          children: [],
          text: "",
        };
        current.children.push(newNode);

        if (!isSelfClosing) {
          stack.push(newNode);
        }
      }
    }
  }

  const feedback = root.children.find((c) =>
    c.tag.toLowerCase().replace(/[-_]/g, "") === "feedback",
  );

  return feedback || root.children[0] || root;
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_\-:]+)\s*=\s*["']([^"']*)["']/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrStr)) !== null) {
    if (match[1] && match[2] !== undefined) {
      attrs[match[1]] = decodeXmlEntities(match[2]);
    }
  }
  return attrs;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ─── Search Helpers ──────────────────────────────────────────────────────────

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, "");
}

function findChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  const target = normalizeTag(name);
  return node.children.find((c) => normalizeTag(c.tag) === target);
}

function findChildren(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  const target = normalizeTag(name);
  return node.children.filter((c) => normalizeTag(c.tag) === target);
}

function getText(node: XmlNode | undefined, childName?: string): string {
  if (!node) return "";
  if (childName) {
    const child = findChild(node, childName);
    return child ? child.text.trim() : "";
  }
  return node.text.trim();
}

function parseDateEpoch(val: string): Date {
  const num = parseInt(val, 10);
  if (isNaN(num)) return new Date(0);
  // If timestamp is in seconds, convert to ms; if already in ms, use directly
  return num > 1e11 ? new Date(num) : new Date(num * 1000);
}

// ─── Main DMARC Parser ───────────────────────────────────────────────────────

/**
 * Parse a raw DMARC aggregate report XML string into a normalized structure.
 * Supports legacy RFC 7489 and RFC 9990 formats and provider extensions.
 */
export function parseDmarcXml(xmlString: string): DmarcAggregateReport {
  if (!xmlString || typeof xmlString !== "string" || !xmlString.trim()) {
    throw new DmarcParseError("Empty XML payload.");
  }

  const root = parseXmlTree(xmlString);
  if (!root || root.tag === "#root") {
    throw new DmarcParseError("Invalid XML structure: missing root feedback element.");
  }

  // ── Version ──
  const versionNode = findChild(root, "version");
  const version = versionNode ? versionNode.text.trim() : undefined;

  // ── Report Metadata ──
  const metaNode = findChild(root, "report_metadata") || findChild(root, "reportmetadata");
  if (!metaNode) {
    throw new DmarcParseError("Missing report_metadata block in DMARC XML.");
  }

  const orgName = getText(metaNode, "org_name") || "Unknown Organization";
  const email = getText(metaNode, "email") || "";
  const extraContactInfo = getText(metaNode, "extra_contact_info") || undefined;
  const reportId = getText(metaNode, "report_id") || `report_${Date.now()}`;

  const dateRangeNode = findChild(metaNode, "date_range") || findChild(metaNode, "daterange");
  const beginEpoch = getText(dateRangeNode, "begin");
  const endEpoch = getText(dateRangeNode, "end");

  const errors = findChildren(metaNode, "error").map((e) => e.text.trim()).filter(Boolean);

  // ── Policy Published ──
  const policyNode = findChild(root, "policy_published") || findChild(root, "policypublished");
  if (!policyNode) {
    throw new DmarcParseError("Missing policy_published block in DMARC XML.");
  }

  const domain = getText(policyNode, "domain") || "";
  const adkim = (getText(policyNode, "adkim").toLowerCase() as DmarcAlignmentMode) || undefined;
  const aspf = (getText(policyNode, "aspf").toLowerCase() as DmarcAlignmentMode) || undefined;
  const p = (getText(policyNode, "p").toLowerCase() as DmarcDisposition) || "none";
  const sp = (getText(policyNode, "sp").toLowerCase() as DmarcDisposition) || undefined;
  const pctStr = getText(policyNode, "pct");
  const pct = pctStr ? parseInt(pctStr, 10) : undefined;
  const fo = getText(policyNode, "fo") || undefined;
  const np = getText(policyNode, "np") || undefined;

  // ── Records ──
  const recordNodes = findChildren(root, "record");
  const records: DmarcRecord[] = recordNodes.map((rec) => {
    const rowNode = findChild(rec, "row");
    const sourceIp = getText(rowNode, "source_ip") || getText(rowNode, "source-ip") || "0.0.0.0";
    const countStr = getText(rowNode, "count");
    const count = countStr ? parseInt(countStr, 10) || 1 : 1;

    const policyEvalNode =
      findChild(rowNode, "policy_evaluated") || findChild(rowNode, "policyevaluated");
    const disposition =
      (getText(policyEvalNode, "disposition").toLowerCase() as DmarcDisposition) || "none";
    const dkimResult =
      getText(policyEvalNode, "dkim").toLowerCase() === "pass" ? "pass" : "fail";
    const spfResult =
      getText(policyEvalNode, "spf").toLowerCase() === "pass" ? "pass" : "fail";

    const reasonNodes = findChildren(policyEvalNode, "reason");
    const reasons: DmarcPolicyOverrideReason[] = reasonNodes.map((rn) => ({
      type: getText(rn, "type"),
      comment: getText(rn, "comment") || undefined,
    }));

    const idNode = findChild(rec, "identifiers");
    const headerFrom = getText(idNode, "header_from") || getText(idNode, "header-from") || domain;
    const envelopeTo = getText(idNode, "envelope_to") || getText(idNode, "envelope-to") || undefined;
    const envelopeFrom =
      getText(idNode, "envelope_from") || getText(idNode, "envelope-from") || undefined;

    const authResultsNode =
      findChild(rec, "auth_results") || findChild(rec, "authresults");

    const dkimAuthNodes = findChildren(authResultsNode, "dkim");
    const dkimAuth = dkimAuthNodes.map((dan) => ({
      domain: getText(dan, "domain"),
      result: (getText(dan, "result").toLowerCase() as DmarcDkimResult) || "fail",
      selector: getText(dan, "selector") || undefined,
      humanResult: getText(dan, "human_result") || undefined,
    }));

    const spfAuthNodes = findChildren(authResultsNode, "spf");
    const spfAuth = spfAuthNodes.map((san) => ({
      domain: getText(san, "domain"),
      result: (getText(san, "result").toLowerCase() as DmarcSpfResult) || "fail",
      scope: getText(san, "scope") || undefined,
    }));

    return {
      row: {
        sourceIp,
        count,
        policyEvaluated: {
          disposition,
          dkim: dkimResult,
          spf: spfResult,
          ...(reasons.length > 0 ? { reasons } : {}),
        },
      },
      identifiers: {
        headerFrom,
        ...(envelopeTo ? { envelopeTo } : {}),
        ...(envelopeFrom ? { envelopeFrom } : {}),
      },
      authResults: {
        dkim: dkimAuth,
        spf: spfAuth,
      },
    };
  });

  return {
    version,
    metadata: {
      orgName,
      email,
      ...(extraContactInfo ? { extraContactInfo } : {}),
      reportId,
      dateRange: {
        begin: parseDateEpoch(beginEpoch),
        end: parseDateEpoch(endEpoch),
      },
      ...(errors.length > 0 ? { errors } : {}),
    },
    policyPublished: {
      domain,
      ...(adkim ? { adkim } : {}),
      ...(aspf ? { aspf } : {}),
      p,
      ...(sp ? { sp } : {}),
      ...(pct !== undefined && !isNaN(pct) ? { pct } : {}),
      ...(fo ? { fo } : {}),
      ...(np ? { np } : {}),
    },
    records,
  };
}
