/** Diagnostics are an allowlist, never a serialization of a request or SDK error. */
const SECRET_PATH =
  /(\/(?:accept-invite|invitation-preview|reset-password|verify-email)\/)[^/?#\s]+/gi;
const MAX_INPUT = 16_384;
// V8 shares this intrinsic getter between Error instances. Comparing identity
// is safer than looking for "native code": a bound application function has
// the same printed representation. Other engines expose a plain stack value.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

export function diagnosticPath(value: string): string {
  const path = value.slice(0, 2048).split(/[?#]/, 1)[0] ?? "/";
  return path.replace(SECRET_PATH, "$1[REDACTED]")
    .replace(/(\/bot)\d+:[A-Za-z0-9_-]+/gi, "$1[REDACTED]")
    .replace(/(\/(?:api\/)?webhooks\/)[^/\s]+\/[^/\s]+/gi, "$1[REDACTED]")
    .replace(/(\/services\/)T[A-Z0-9]+\/B[A-Z0-9]+\/[^/\s]+/gi, "$1[REDACTED]");
}

/** Bound work before running expressions; also redact incomplete/truncated secrets. */
export function redactDiagnosticText(value: string, limit = 2048): string {
  let text = value.slice(0, MAX_INPUT);
  text = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
      "[REDACTED PEM]",
    )
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-internal-token|x-api-key)\s*[:=][^\r\n]*/gi,
      "[REDACTED HEADER]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED AUTH]")
    .replace(
      /\bchallenge\s+["'][^"'\r\n]*(?:["']|$)(?:,\s*expected\s+["'][^"'\r\n]*(?:["']|$))?/gi,
      "challenge [REDACTED]",
    )
    .replace(/\b(?:command failed|executing command|command:)\s*[^\n]*/gi, "[REDACTED COMMAND]")
    .replace(
      /(?:--(?:password|passwd|secret|token|api-key|private-key|eab-hmac-key|eab-kid)|-pass)\s+(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s]+)/gi,
      "[REDACTED ARGUMENT]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk_(?:live_|test_)?|oblien_)[A-Za-z0-9_-]{12,}/g,
      "[REDACTED TOKEN]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[REDACTED TOKEN]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${diagnosticPath(url.pathname)}`;
      } catch {
        return "[REDACTED URL]";
      }
    })
    // Shell environments and inline connection/auth options can be present in
    // child-process errors. Even an innocently named variable may be a secret.
    .replace(/\b[A-Z][A-Z0-9_]*=(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s;,]*)/g, "[REDACTED ENV]")
    .replace(
      /\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|signature|eab[_-]hmac[_-]key)[\w.-]*["']?\s*[:=]\s*(?!\d+:\d+(?:\)|\s|$))(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;}\n]+)/gi,
      "[REDACTED CREDENTIAL]",
    )
    .replace(
      /\b(?:failed query|query|sql|params|parameters|request body|response body|environment)\s*:[\s\S]*/gi,
      "[REDACTED PAYLOAD]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]");
  text = diagnosticPathInText(text);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function diagnosticPathInText(value: string): string {
  return value
    .replace(SECRET_PATH, "$1[REDACTED]")
    .replace(/(\/[\w/.[\]:%-]+)\?[^\s]*/g, "$1?[REDACTED]");
}

/** Avoid getters, toJSON/toString and provider object graphs (including Proxies). */
export function diagnosticProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < 4; depth++) {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property) {
        if ("value" in property) return property.value;
        // DOMException's standard getters validate their internal brand. Call
        // only that exact prototype accessor, never an application override.
        if (
          typeof DOMException !== "undefined" &&
          current === DOMException.prototype &&
          ["name", "message", "code"].includes(key) &&
          property.get
        ) {
          return Reflect.apply(property.get, value, []);
        }
        return undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    /* A hostile thrown value must never break its error handler. */
  }
  return undefined;
}

/** V8 22+ exposes Error.stack through a native own accessor, not a data property. */
export function diagnosticStack(value: unknown): unknown {
  const data = diagnosticProperty(value, "stack");
  if (typeof data === "string") return data;
  if (!value || typeof value !== "object") return undefined;
  try {
    // V8 formats its lazy stack using name/message. Avoid executing an
    // application-defined accessor indirectly through that native formatter.
    for (const key of ["name", "message"]) {
      let current: object | null = value;
      let inspected = false;
      for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
        const property = Object.getOwnPropertyDescriptor(current, key);
        if (property) {
          if (
            !("value" in property) ||
            (property.value !== undefined && typeof property.value !== "string")
          )
            return undefined;
          inspected = true;
          break;
        }
      }
      // A formatter would keep walking a longer prototype chain. Do not let it
      // reach a getter beyond our bounded inspection.
      if (current && !inspected) return undefined;
    }
    const getter = Object.getOwnPropertyDescriptor(value, "stack")?.get;
    // Only the captured intrinsic is allowed, never a custom or bound getter.
    if (getter && getter === nativeStackGetter) return Reflect.apply(getter, value, []);
  } catch {
    /* Stack collection is optional and must not affect the handler. */
  }
  return undefined;
}
