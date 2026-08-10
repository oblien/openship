"use client";

import React, { useEffect, useRef } from "react";
import {
  flattenSettingFields,
  envToSettingValue,
  settingToEnvValue,
  validateSetting,
  isFieldVisible,
  splitMultiValue,
  getAppTemplate,
  getAppManagement,
  type AppSettingField,
  type AppSettingGroup,
} from "@repo/core";
import type { AppSettingsView } from "@/lib/api/apps";

/** A catalog app whose template exposes curated (schema) settings — drives the
 *  "App settings" mode of the Configuration tab + the install-wizard step. */
export function isSchemaAppTemplate(appTemplateId?: string): boolean {
  if (!appTemplateId) return false;
  const tpl = getAppTemplate(appTemplateId);
  return !!tpl && getAppManagement(tpl)?.kind === "schema";
}

/**
 * Presentational, schema-driven settings form — the ONE renderer shared by the
 * day-2 project Settings tab and the install-time deploy-wizard step. It's fully
 * controlled: the parent owns value state (via `useAppSettings`) and the toolbar
 * (save / apply / advanced toggle). This component only turns a schema + values
 * into inputs, so both surfaces stay identical with zero duplication.
 */

export type FormValue = string | boolean;

/** Stable form-state key. Service names + env keys never contain spaces. */
export const fk = (service: string, key: string) => `${service} ${key}`;

/** Seed controlled form state from a settings view (secrets always start blank). */
export function seedFormValues(view: AppSettingsView): Record<string, FormValue> {
  const byKey = new Map(view.values.map((x) => [fk(x.service, x.key), x]));
  const next: Record<string, FormValue> = {};
  for (const f of flattenSettingFields(view.groups)) {
    const entry = byKey.get(fk(f.service, f.key));
    next[fk(f.service, f.key)] = f.secret
      ? ""
      : envToSettingValue(f, entry?.set ? entry.value : undefined);
  }
  return next;
}

/** Diff current values vs their seeded initial → the env changes to persist. */
export function buildChanges(
  fields: AppSettingField[],
  values: Record<string, FormValue>,
  initial: Record<string, FormValue>,
): { service: string; key: string; value: string }[] {
  const out: { service: string; key: string; value: string }[] = [];
  for (const f of fields) {
    const k = fk(f.service, f.key);
    const cur = values[k];
    if (f.secret) {
      if (cur === "" || cur === undefined) continue; // blank secret = unchanged
      out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur) });
    } else if (cur !== initial[k]) {
      out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur) });
    }
  }
  return out;
}

/** Aggregate validity of the currently-VISIBLE fields (hidden `showIf` fields
 *  don't gate). `missingRequiredKeys` are the fk()s of empty required fields. */
export interface FormValidity {
  valid: boolean;
  hasErrors: boolean;
  missingRequiredKeys: string[];
}

interface AppSettingsFormProps {
  groups: readonly AppSettingGroup[];
  values: Record<string, FormValue>;
  onChange: (field: AppSettingField, value: FormValue) => void;
  /** Whether a secret currently has a stored value (drives the "set" hint). */
  isSet?: (field: AppSettingField) => boolean;
  secretSetLabel: string;
  /** Show fields marked `advanced`. */
  showAdvanced?: boolean;
  /** Render only fields matching this predicate (e.g. install-step at first deploy). */
  filter?: (field: AppSettingField) => boolean;
  /** Render every (filtered) field in ONE card with no per-group headers —
   *  used by the install step, where the schema's group labels (e.g. "Advanced")
   *  would be misleading. */
  flat?: boolean;
  /** Heading for `flat` mode. */
  title?: string;
  /** Reported whenever validity of the visible fields changes (install wizard
   *  gates Install on this; the day-2 tab omits it). */
  onValidityChange?: (v: FormValidity) => void;
}

export function AppSettingsForm({
  groups,
  values,
  onChange,
  isSet,
  secretSetLabel,
  showAdvanced = false,
  filter,
  flat = false,
  title,
  onValidityChange,
}: AppSettingsFormProps) {
  // A field is shown when it passes the caller's filter + advanced gate AND its
  // `showIf` condition holds against current values. `showIf` reads sibling
  // values by (service, key) — the same fk() the form state is keyed on.
  const valueGet = (service: string, key: string) => values[fk(service, key)];
  const shown = (f: AppSettingField) =>
    (!filter || filter(f)) && (showAdvanced || !f.advanced) && isFieldVisible(f, valueGet);

  // validateSetting works on the ENV string; boolean controls can't be invalid.
  const errorFor = (f: AppSettingField): string | null => {
    const v = values[fk(f.service, f.key)];
    return typeof v === "string" ? validateSetting(f, v) : null;
  };
  const isEmpty = (f: AppSettingField): boolean => {
    const v = values[fk(f.service, f.key)];
    return v === undefined || v === "";
  };

  // Report aggregate validity of the VISIBLE fields (hidden ones never gate).
  const visibleAll = flattenSettingFields(groups).filter(shown);
  const missingRequiredKeys = visibleAll
    .filter((f) => f.required && !f.secret && isEmpty(f))
    .map((f) => fk(f.service, f.key));
  const hasErrors = visibleAll.some((f) => errorFor(f) != null);
  const summary = `${hasErrors}|${missingRequiredKeys.join(",")}`;
  const lastSummary = useRef<string | null>(null);
  useEffect(() => {
    if (!onValidityChange) return;
    if (lastSummary.current === summary) return;
    lastSummary.current = summary;
    onValidityChange({ valid: !hasErrors && missingRequiredKeys.length === 0, hasErrors, missingRequiredKeys });
  }, [summary, hasErrors, missingRequiredKeys, onValidityChange]);

  const renderField = (f: AppSettingField) => (
    <Field
      key={fk(f.service, f.key)}
      field={f}
      value={values[fk(f.service, f.key)]}
      error={errorFor(f)}
      secretSet={!!isSet?.(f)}
      secretSetLabel={secretSetLabel}
      onChange={(v) => onChange(f, v)}
    />
  );

  if (flat) {
    const fields = visibleAll;
    if (fields.length === 0) return null;
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
        <div className={`space-y-4 ${title ? "mt-4" : ""}`}>{fields.map(renderField)}</div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const visible = group.fields.filter(shown);
        if (visible.length === 0) return null;
        return (
          <div key={group.id} className="bg-card rounded-2xl border border-border/50 p-5">
            <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
            {group.description && (
              <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
            )}
            <div className="mt-4 space-y-4">{visible.map(renderField)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Does any (optionally filtered) field carry the `advanced` flag? */
export function hasAdvancedFields(
  groups: readonly AppSettingGroup[],
  filter?: (field: AppSettingField) => boolean,
): boolean {
  return flattenSettingFields(groups).some((f) => f.advanced && (!filter || filter(f)));
}

function Field({
  field,
  value,
  error,
  secretSet,
  secretSetLabel,
  onChange,
}: {
  field: AppSettingField;
  value: FormValue | undefined;
  error: string | null;
  secretSet: boolean;
  secretSetLabel: string;
  onChange: (v: FormValue) => void;
}) {
  // Same field treatment as the surfaces this form sits on (the app-install
  // wizard's "Name" box, project settings): `border-border/50` + a focus ring.
  // `border-input` is double the alpha on dark, so a settings field read as an
  // outlined box next to its borderless neighbours.
  const base =
    "w-full rounded-xl border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25";
  const inputCls = `${base} ${error ? "border-danger" : "border-border/50"}`;
  const str = typeof value === "string" ? value : "";
  // Password type OR an explicitly-secret field masks (fixes the old bug where a
  // type:"password" non-secret field rendered as visible text).
  const masked = field.secret || field.type === "password";
  const selected = field.type === "multiselect" ? new Set(splitMultiValue(field, str)) : null;
  const toggleMulti = (val: string) => {
    const next = new Set(selected ?? []);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange([...next].join(field.separator ?? ","));
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-foreground">
          {field.label}
          {field.required && <span className="ms-0.5 text-danger">*</span>}
        </label>
        {field.type === "boolean" && (
          <button
            type="button"
            role="switch"
            aria-checked={value === true}
            onClick={() => onChange(!(value === true))}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              value === true ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-background transition-transform ${
                value === true ? "translate-x-[18px]" : "translate-x-0.5"
              }`}
            />
          </button>
        )}
      </div>

      {field.type === "boolean" ? null : field.type === "select" ? (
        <select className={`${inputCls} mt-2`} value={str} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === "radio" ? (
        <div className="mt-2 space-y-1.5">
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name={fk(field.service, field.key)}
                checked={str === o.value}
                onChange={() => onChange(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : field.type === "multiselect" ? (
        <div className="mt-2 space-y-1.5">
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={!!selected?.has(o.value)}
                onChange={() => toggleMulti(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : field.type === "textarea" ? (
        <textarea
          className={`${inputCls} mt-2 min-h-24 font-mono`}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type={masked ? "password" : field.type === "number" ? "number" : "text"}
          className={`${inputCls} mt-2`}
          value={str}
          placeholder={field.placeholder}
          autoComplete={masked ? "new-password" : undefined}
          min={field.type === "number" ? field.min : undefined}
          max={field.type === "number" ? field.max : undefined}
          step={field.type === "number" ? (field.step ?? (field.integer ? 1 : undefined)) : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : (
        field.help && <p className="mt-1.5 text-xs text-muted-foreground">{field.help}</p>
      )}
      {field.secret && secretSet && (
        <p className="mt-1 text-xs text-muted-foreground">{secretSetLabel}</p>
      )}
    </div>
  );
}
