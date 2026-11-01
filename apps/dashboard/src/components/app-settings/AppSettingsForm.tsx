"use client";

import React, { useEffect, useId, useRef } from "react";
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
import { cn } from "@/lib/utils";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input, inputVariants } from "@/components/ui/input";

/** A catalog app with curated fields for project Settings and the install wizard. */
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

/** Seed newly received catalog fields without resetting edits, including empty values. */
export function withSettingDefaults(
  fields: readonly AppSettingField[],
  values: Record<string, FormValue> = {},
): Record<string, FormValue> {
  let next = values;
  for (const field of fields) {
    const key = fk(field.service, field.key);
    if (next[key] !== undefined) continue;
    if (next === values) next = { ...values };
    next[key] = envToSettingValue(field, undefined);
  }
  return next;
}

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
  /** Default field columns; individual groups can override this outside flat mode. */
  columns?: 1 | 2;
  /** An extra field before the settings in flat mode, such as the install's project name. */
  leadingContent?: React.ReactNode;
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
  columns = 1,
  leadingContent,
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

  const cards = flat
    ? [
        {
          id: "flat",
          label: title,
          description: undefined,
          columns,
          fields: visibleAll,
          leadingContent,
        },
      ]
    : groups.map((group) => ({
        ...group,
        columns: group.columns ?? columns,
        fields: group.fields.filter(shown),
        leadingContent: undefined,
      }));
  const visibleCards = cards.filter((group) => group.fields.length > 0 || group.leadingContent);
  if (visibleCards.length === 0) return null;

  return (
    <div className="space-y-5">
      {visibleCards.map((group) => {
        return (
          <div key={group.id} className="@container/app-settings rounded-2xl bg-card p-5">
            {group.label && <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>}
            {group.description && (
              <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
            )}
            <div
              className={cn(
                "grid grid-cols-1 items-start gap-4",
                (group.label || group.description) && "mt-4",
                group.columns === 2 && "@min-[32rem]/app-settings:grid-cols-2",
              )}
            >
              {group.leadingContent}
              {group.fields.map(renderField)}
            </div>
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
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const isChoiceGroup = field.type === "radio" || field.type === "multiselect";
  const errorClassName = error ? "ring-1 ring-danger" : undefined;
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
    <div className={cn("min-w-0", field.fullWidth && "col-span-full")}>
      <div className="flex items-center justify-between gap-3">
        <label
          id={labelId}
          htmlFor={isChoiceGroup ? undefined : inputId}
          className="text-sm font-medium text-foreground"
        >
          {field.label}
          {field.required && <span className="ms-0.5 text-danger">*</span>}
        </label>
        {field.type === "boolean" && (
          <button
            id={inputId}
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
        <CustomSelect
          id={inputId}
          aria-label={field.label}
          className="mt-2"
          variant="filled"
          triggerClassName={cn("bg-muted/60 hover:bg-muted", errorClassName)}
          value={str}
          options={[...(field.options ?? [])]}
          onChange={onChange}
          placeholder={field.placeholder}
        />
      ) : field.type === "radio" ? (
        <div role="radiogroup" aria-labelledby={labelId} className="mt-2 space-y-1.5">
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
        <div role="group" aria-labelledby={labelId} className="mt-2 space-y-1.5">
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
          id={inputId}
          className={cn(
            inputVariants({ variant: "filled" }),
            "mt-2 h-auto min-h-24 font-mono",
            errorClassName,
          )}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={inputId}
          type={masked ? "password" : field.type === "number" ? "number" : "text"}
          variant="filled"
          className={cn("mt-2", errorClassName)}
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
