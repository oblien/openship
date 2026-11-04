import type { Field } from "mindwire";

/** Mindwire owns the schema. Resolve its defaults before applying field dependencies. */
export function resolveAssistantFields(fields: readonly Field[], input: Record<string, string>) {
  const values = Object.fromEntries(
    fields.map((field) => [field.key, input[field.key] ?? field.default ?? ""]),
  );
  const visible = fields.filter(
    (field) =>
      !field.visibleWhen || values[field.visibleWhen.key]?.trim() === field.visibleWhen.equals,
  );
  return { values, visible };
}

/** Hidden alternatives must not change which credential or endpoint the daemon selects. */
export function assistantFieldInput(fields: readonly Field[], input: Record<string, string>) {
  const { values, visible } = resolveAssistantFields(fields, input);
  return Object.fromEntries(visible.map((field) => [field.key, values[field.key]!.trim()]));
}
