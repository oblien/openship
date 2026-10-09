"use client";

import type { ActionWorkflowView } from "@repo/contracts";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input } from "@/components/ui/input";
import { ActionField } from "./ActionField";

type Inputs = ActionWorkflowView["plan"]["inputs"];

export function workflowInputDefaults(inputs: Inputs): Record<string, string> {
  return Object.fromEntries(inputs.map((input) => [input.name, input.default]));
}

/** Manual dispatch and Jobs use the same declared workflow inputs. */
export function WorkflowInputs({
  definitions,
  values,
  onChange,
}: {
  definitions: Inputs;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  return definitions.map((input) => (
    <ActionField key={input.name} label={input.name} hint={input.description}>
      {input.type === "boolean" ? (
        <Checkbox
          aria-label={input.name}
          checked={(values[input.name] ?? input.default) === "true"}
          onCheckedChange={(value) => onChange({ ...values, [input.name]: String(value) })}
        />
      ) : input.options.length ? (
        <CustomSelect
          aria-label={input.name}
          variant="filled"
          triggerClassName="bg-muted/60 hover:bg-muted"
          value={values[input.name] ?? input.default}
          onChange={(value) => onChange({ ...values, [input.name]: value })}
          options={input.options.map((value) => ({ value, label: value }))}
        />
      ) : (
        <Input
          variant="filled"
          value={values[input.name] ?? input.default}
          required={input.required}
          type={input.type === "number" ? "number" : "text"}
          onChange={(event) => onChange({ ...values, [input.name]: event.target.value })}
        />
      )}
    </ActionField>
  ));
}
