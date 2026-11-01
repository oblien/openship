"use client";
import { useId } from "react";
import { Icon } from "@repo/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export type ActionValue = { id: string; name: string; value: string; saved?: boolean };
export function ActionValues({
  secret,
  values,
  onChange,
}: {
  secret?: boolean;
  values: ActionValue[];
  onChange: (values: ActionValue[]) => void;
}) {
  const { t } = useI18n();
  const a = t.actions;
  const prefix = useId();
  return (
    <div className="space-y-3">
      {values.map((pair, index) => (
        <div className="flex items-center gap-2" key={pair.id}>
          <Input
            id={`${prefix}-${index}-name`}
            aria-label={`${secret ? a.secrets : a.variables}: ${a.key} ${index + 1}`}
            value={pair.name}
            placeholder="MY_VARIABLE"
            variant="filled"
            className="min-w-0 flex-1 font-mono"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            required
            disabled={pair.saved}
            onChange={(event) =>
              onChange(
                values.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)),
              )
            }
          />
          <Input
            aria-label={`${a.value}: ${pair.name || index + 1}`}
            value={pair.value}
            placeholder={pair.saved ? "••••••••" : a.value}
            autoComplete="off"
            type={secret ? "password" : "text"}
            variant="filled"
            className="min-w-0 flex-1"
            onChange={(event) =>
              onChange(
                values.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${a.remove}: ${pair.name || index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onChange([...values, { id: crypto.randomUUID(), name: "", value: "" }])}
      >
        <Icon name="plus" />
        {a.addValue}
      </Button>
    </div>
  );
}
