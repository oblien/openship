"use client";

import { useEffect, useId, useState } from "react";
import { isMaskedValue } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import type { EnvironmentVariableRow } from "@/components/import-project/EnvironmentVariables";

/** A view of the existing TZ row, never a second persisted timezone setting. */
export function EnvironmentTimezone<Row extends EnvironmentVariableRow>({
  rows,
  onChange,
  createRow,
  disabled = false,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  createRow: (value: string) => Row;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.importProject.environmentVariables.timezone;
  const id = useId();
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => {
    setZones(Intl.supportedValuesOf("timeZone"));
  }, []);
  const matches = rows.filter((row) => row.key.trim() === "TZ");
  const row = matches[0];
  const hidden = Boolean(row?.preserveValue || (row && isMaskedValue(row.value)));
  const ambiguous = matches.length > 1;
  const value = hidden ? "" : (row?.value ?? "");
  const options = [...new Set(["UTC", ...zones, ...(value ? [value] : [])])].map((zone) => ({
    value: zone,
    label: zone,
  }));
  // Required/inherited rows retain their existing removal policy.
  if (!row?.removalDisabled) options.unshift({ value: "", label: copy.imageDefault });

  return (
    <div className="space-y-2 pb-3">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {copy.label}
      </label>
      <CustomSelect
        id={id}
        aria-label={copy.label}
        value={value}
        options={hidden ? [{ value: "", label: copy.hidden }] : options}
        disabled={disabled || hidden || ambiguous}
        searchable
        searchPlaceholder={copy.search}
        variant="filled"
        triggerClassName="bg-muted/60 hover:bg-muted"
        onChange={(next) => {
          if (disabled || hidden || ambiguous || next === value) return;
          if (!next) {
            if (!row?.removalDisabled) onChange(rows.filter((item) => item !== row));
          } else if (row) {
            onChange(
              rows.map((item) =>
                item === row ? { ...item, value: next, preserveValue: false } : item,
              ),
            );
          } else {
            onChange([...rows, createRow(next)]);
          }
        }}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {ambiguous ? copy.duplicate : hidden ? copy.hiddenHint : copy.hint}
      </p>
    </div>
  );
}
