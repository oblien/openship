"use client";
import { useId } from "react";
import { resolveAssistantFields, type AssistantField } from "@repo/contracts";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";

/** Render Mindwire's declared fields; no provider-specific credential forms. */
export function AssistantFields({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: AssistantField[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
  disabled?: boolean;
}) {
  const prefix = useId(),
    resolved = resolveAssistantFields(fields, values);
  const render = (field: AssistantField) => {
    const value = resolved.values[field.key] ?? "",
      id = `${prefix}-${field.key}`;
    const update = (value: string) => onChange({ ...values, [field.key]: value });
    return (
      <div key={field.key} className="space-y-2">
        <label htmlFor={id} className="text-sm font-medium">
          {field.label}
          {!field.required && (
            <span className="ms-1.5 font-normal text-muted-foreground">(optional)</span>
          )}
        </label>
        {field.type === "select" && field.options ? (
          <CustomSelect
            id={id}
            aria-label={field.label}
            value={value}
            onChange={update}
            options={field.options.map((o) => ({ value: o.value, label: o.label }))}
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            disabled={disabled}
          />
        ) : field.type === "toggle" ? (
          <Checkbox
            id={id}
            aria-label={field.label}
            checked={value === "true"}
            onCheckedChange={(checked) => update(String(checked))}
            disabled={disabled}
          />
        ) : field.type === "multiselect" ? (
          <div className="grid gap-2">
            {field.options?.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={value.split(",").includes(option.value)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    update(
                      (checked
                        ? [...value.split(",").filter(Boolean), option.value]
                        : value.split(",").filter((v) => v !== option.value)
                      ).join(","),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
        ) : (
          <Input
            id={id}
            variant="filled"
            type={field.type === "secret" ? "password" : "text"}
            autoComplete="off"
            value={value}
            placeholder={field.placeholder}
            onChange={(event) => update(event.target.value)}
            disabled={disabled}
          />
        )}
        {field.help && <p className="text-xs leading-5 text-muted-foreground">{field.help}</p>}
      </div>
    );
  };
  const visible = resolved.visible;
  return (
    <div className="space-y-5">
      {visible.filter((f) => !f.advanced).map(render)}
      {visible.some((f) => f.advanced) && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Advanced options
          </summary>
          <div className="mt-4 space-y-5">{visible.filter((f) => f.advanced).map(render)}</div>
        </details>
      )}
    </div>
  );
}
