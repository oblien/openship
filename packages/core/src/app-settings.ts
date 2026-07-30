/**
 * Curated day-2 settings for installed apps.
 *
 * Distinct from install-time `configFields` (which are generated secrets filled
 * once at install): these are the operator-editable knobs an app exposes AFTER
 * install, rendered as a friendly form instead of raw per-service env editing.
 * Each field maps to exactly one env key on one service; the dashboard writes
 * them through the safe merge-env path and applies with a restart (or a full
 * redeploy for `requiresRedeploy` fields).
 */

/** How an installed app surfaces its management UI. */
export type AppManagement =
  | { kind: "schema" }
  | { kind: "custom"; href: string };

export interface AppSettingOption {
  value: string;
  label: string;
}

export interface AppSettingField {
  /** Env key this setting reads/writes. */
  key: string;
  /** Service whose env this setting lives on. */
  service: string;
  label: string;
  help?: string;
  type: "text" | "password" | "boolean" | "select" | "number" | "multiselect" | "radio" | "textarea";
  /** Choices for `type:"select"` / `"radio"` / `"multiselect"`. */
  options?: readonly AppSettingOption[];
  /** Join char for a `type:"multiselect"` value in the stored env string (default ","). */
  separator?: string;
  /** Bounds for `type:"number"` (inclusive). */
  min?: number;
  max?: number;
  /** Step for a `type:"number"` input. */
  step?: number;
  /** Require a whole number for `type:"number"`. */
  integer?: boolean;
  /** Regex a `type:"text"|"textarea"|"password"` value must match (whole string). */
  pattern?: string;
  /** Message shown when `pattern` fails (else a generic one). */
  patternError?: string;
  /** Effective value when the env key is unset. */
  default?: string;
  placeholder?: string;
  /** Stored encrypted; masked on read; blank on save means "leave unchanged". */
  secret?: boolean;
  /** Env strings a boolean maps to (default "true"/"false"). */
  trueValue?: string;
  falseValue?: string;
  /** Needs a full redeploy to take effect, not just a restart-apply. */
  requiresRedeploy?: boolean;
  /** Tuck under the collapsible Advanced block within the app's settings. */
  advanced?: boolean;
  /** Collect this field in the install wizard step (before first deploy), not
   *  only in the day-2 tab. Fields safe/meaningful to set at install (e.g. a
   *  name that's dangerous to change later, or required credentials). */
  installStep?: boolean;
  /** Must be non-empty before the app can be deployed (install-wizard gate). */
  required?: boolean;
  /**
   * Show this field only when another field's value matches — a SIMPLE
   * equals/truthy check (never an expression / eval). `field` (+ optional
   * `service`, defaults to this field's service) identifies the controlling
   * field; `equals` matches a value or any in a list; `truthy` shows when the
   * controlling value is non-empty / boolean-true.
   */
  showIf?: {
    field: string;
    service?: string;
    equals?: string | readonly string[];
    truthy?: boolean;
  };
}

export interface AppSettingGroup {
  id: string;
  label: string;
  description?: string;
  fields: readonly AppSettingField[];
}

export const settingTrueValue = (f: AppSettingField): string => f.trueValue ?? "true";
export const settingFalseValue = (f: AppSettingField): string => f.falseValue ?? "false";

export function flattenSettingFields(groups: readonly AppSettingGroup[]): AppSettingField[] {
  return groups.flatMap((g) => [...g.fields]);
}

export function findSettingField(
  groups: readonly AppSettingGroup[],
  service: string,
  key: string,
): AppSettingField | undefined {
  return flattenSettingFields(groups).find((f) => f.service === service && f.key === key);
}

/** Env string → the value shape the UI control expects. */
export function envToSettingValue(field: AppSettingField, env: string | undefined): string | boolean {
  if (field.type === "boolean") return (env ?? field.default) === settingTrueValue(field);
  return env ?? field.default ?? "";
}

/** UI control value → the env string to store. */
export function settingToEnvValue(field: AppSettingField, raw: string | boolean): string {
  if (field.type === "boolean") {
    const on = typeof raw === "boolean" ? raw : raw === settingTrueValue(field) || raw === "true";
    return on ? settingTrueValue(field) : settingFalseValue(field);
  }
  return String(raw);
}

/**
 * Validate a proposed env string for a field. Empty is always allowed (means
 * "clear to default" for plain fields, "leave unchanged" for secrets). Returns
 * an error message, or null when valid.
 */
export function validateSetting(field: AppSettingField, raw: string): string | null {
  if (raw === "") return null;
  if (field.type === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return `${field.label} must be a number`;
    const n = Number(raw);
    if (field.integer && !Number.isInteger(n)) return `${field.label} must be a whole number`;
    if (field.min != null && n < field.min) return `${field.label} must be at least ${field.min}`;
    if (field.max != null && n > field.max) return `${field.label} must be at most ${field.max}`;
    return null;
  }
  if (field.type === "select" || field.type === "radio") {
    const allowed = (field.options ?? []).map((o) => o.value);
    if (!allowed.includes(raw)) return `${field.label} must be one of: ${allowed.join(", ")}`;
    return null;
  }
  if (field.type === "multiselect") {
    const allowed = new Set((field.options ?? []).map((o) => o.value));
    const bad = splitMultiValue(field, raw).filter((t) => !allowed.has(t));
    if (bad.length) return `${field.label}: unknown option(s) ${bad.join(", ")}`;
    return null;
  }
  if (field.type === "boolean") {
    if (raw !== settingTrueValue(field) && raw !== settingFalseValue(field)) {
      return `${field.label} must be a boolean`;
    }
    return null;
  }
  // text / textarea / password
  if (field.pattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(field.pattern);
    } catch {
      re = null; // a malformed author pattern never blocks the user
    }
    if (re && !re.test(raw)) return field.patternError ?? `${field.label} has an invalid format`;
  }
  return null;
}

/** Tokens of a `multiselect` env string (trimmed, empties dropped). */
export function splitMultiValue(field: AppSettingField, raw: string): string[] {
  return raw
    .split(field.separator ?? ",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Evaluate a field's `showIf` against the current form values. No `showIf` ⇒
 * always visible. Simple equals/truthy only (never eval). `get(service, key)`
 * returns the current raw value of another field on the form.
 */
export function isFieldVisible(
  field: AppSettingField,
  get: (service: string, key: string) => string | boolean | undefined,
): boolean {
  const cond = field.showIf;
  if (!cond) return true;
  const cur = get(cond.service ?? field.service, cond.field);
  if (cond.truthy !== undefined) {
    const truthy = cur === true || (typeof cur === "string" && cur !== "" && cur !== "false");
    return cond.truthy ? truthy : !truthy;
  }
  if (cond.equals !== undefined) {
    const curStr = typeof cur === "boolean" ? String(cur) : (cur ?? "");
    const list = Array.isArray(cond.equals) ? cond.equals : [cond.equals];
    return list.includes(curStr);
  }
  return true;
}
