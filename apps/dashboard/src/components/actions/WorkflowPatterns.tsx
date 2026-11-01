"use client";
import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { TagListInput } from "@/components/ui/TagListInput";
import { CustomSelect } from "@/components/ui/CustomSelect";

/** One pattern per chip; commas inside glob expressions remain literal. */
export function WorkflowPatterns({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: unknown;
  onChange: (patterns: string[]) => void;
  label: string;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  return (
    <div dir="ltr">
      <TagListInput
        variant="filled"
        tags={Array.isArray(value) ? value.map(String) : []}
        draft={draft}
        onDraftChange={setDraft}
        onTagsChange={onChange}
        ariaLabel={label}
        removeLabel={t.actions.remove}
        addLabel={`${t.actions.addValue}: ${label}`}
        placeholder={placeholder}
        splitCommas={false}
      />
    </div>
  );
}

export function WorkflowPatternFilter({
  label,
  field,
  config,
  onChange,
  placeholder,
}: {
  label: string;
  field: "branches" | "paths" | "tags";
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  const c = t.actions.integration;
  const excluded = Object.hasOwn(config, `${field}-ignore`);
  const [emptyMode, setEmptyMode] = useState<"include" | "exclude">("include");
  const mode = excluded ? "exclude" : Object.hasOwn(config, field) ? "include" : emptyMode;
  const key = mode === "exclude" ? `${field}-ignore` : field;
  const update = (values: string[], nextMode = mode) => {
    const next = { ...config };
    delete next[field];
    delete next[`${field}-ignore`];
    if (values.length) next[nextMode === "exclude" ? `${field}-ignore` : field] = values;
    setEmptyMode(nextMode);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        <CustomSelect
          value={mode}
          onChange={(mode) =>
            update(Array.isArray(config[key]) ? (config[key] as string[]) : [], mode)
          }
          options={[
            { value: "include", label: c.include },
            { value: "exclude", label: c.exclude },
          ]}
          aria-label={`${label}: ${c.filterMode}`}
          triggerClassName="!min-h-7 !h-7 !w-auto !gap-2 !border-0 !bg-transparent !px-1 !py-0 !text-xs text-muted-foreground"
          className="w-auto"
        />
      </div>
      <WorkflowPatterns
        value={config[key]}
        label={label}
        onChange={update}
        placeholder={placeholder}
      />
    </div>
  );
}
