"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ActionField } from "./ActionField";
import { ActionError } from "./ActionStatus";
import {
  editWorkflowTrigger,
  workflowTriggers,
  workflowEventConfig as object,
  workflowPatterns,
  parseWorkflowPatterns,
  type WorkflowEvent,
} from "./workflow-yaml";

export function WorkflowTriggers({
  source,
  onChange,
  standalone,
}: {
  source: string;
  onChange: (source: string) => void;
  standalone: boolean;
}) {
  const { t } = useI18n();
  const a = t.actions,
    c = a.integration;
  const [error, setError] = useState<string | null>(null);
  let triggers: Record<string, unknown> = {};
  try {
    triggers = workflowTriggers(source);
  } catch {
    // diagnostics-ignore: Incomplete user-edited YAML is inline validation, not a runtime failure.
    return <p className="text-sm text-muted-foreground">{c.fixYaml}</p>;
  }
  const change = (event: WorkflowEvent, value: unknown) => {
    try {
      onChange(editWorkflowTrigger(source, event, value));
      setError(null);
    } catch (error) {
      // diagnostics-ignore: A YAML edit conflict is presented beside the editor without reporting its potentially secret source.
      setError(error instanceof Error ? error.message : c.fixYaml);
    }
  };
  const update = (event: WorkflowEvent, key: string, value: unknown) => {
    const config = { ...object(triggers[event]) };
    if (value === undefined) delete config[key];
    else config[key] = value;
    change(event, config);
  };
  const events: Array<{ event: WorkflowEvent; label: string; hint: string }> = [
    { event: "workflow_dispatch", label: c.manual, hint: c.manualHint },
    ...(!standalone
      ? [
          { event: "push" as const, label: c.push, hint: c.pushHint },
          { event: "pull_request" as const, label: c.pullRequest, hint: c.pullRequestHint },
        ]
      : []),
    {
      event: "schedule",
      label: c.schedule,
      hint: standalone ? c.standaloneScheduleHint : c.scheduleHint,
    },
    { event: "repository_dispatch", label: c.webhook, hint: c.webhookHint },
  ];
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <h2 className="text-sm font-semibold">{c.triggers}</h2>
      <ActionError message={error} />
      <div className="divide-y divide-border/50">
        {events.map(({ event, label, hint }) => {
          const enabled = Object.hasOwn(triggers, event),
            config = object(triggers[event]);
          return (
            <div className="py-4 first:pt-0 last:pb-0" key={event}>
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    change(
                      event,
                      checked ? (event === "schedule" ? [{ cron: "0 3 * * *" }] : {}) : undefined,
                    )
                  }
                />
                <span className="min-w-0 text-sm font-medium">
                  {label}
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </label>
              {enabled && (event === "push" || event === "pull_request") && (
                <div className="mt-4 grid gap-4 @min-[600px]:grid-cols-2">
                  {(["branches", "paths"] as const).map((key) => (
                    <ActionField
                      label={key === "branches" ? c.branches : c.paths}
                      hint={c.filterHint}
                      key={key}
                    >
                      <DraftTextarea
                        dir="ltr"
                        spellCheck={false}
                        className="min-h-20 w-full rounded-xl bg-background p-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
                        value={workflowPatterns(config[key])}
                        placeholder={key === "branches" ? "main\nrelease/**" : "src/**"}
                        onChange={(e) => {
                          const values = parseWorkflowPatterns(e.target.value);
                          update(event, key, values.length ? values : undefined);
                        }}
                      />
                    </ActionField>
                  ))}
                  {!!(
                    config["branches-ignore"] ||
                    config["paths-ignore"] ||
                    config.tags ||
                    config["tags-ignore"] ||
                    config.types
                  ) && (
                    <p className="text-xs text-muted-foreground @min-[600px]:col-span-2">
                      {c.extraFilters}
                    </p>
                  )}
                </div>
              )}
              {enabled && event === "schedule" && (
                <ActionField label={c.cron} hint={c.cronHint} className="mt-4">
                  <DraftTextarea
                    dir="ltr"
                    spellCheck={false}
                    className="min-h-20 w-full rounded-xl bg-background p-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
                    value={
                      Array.isArray(triggers.schedule)
                        ? triggers.schedule.map((row) => String(object(row).cron ?? "")).join("\n")
                        : ""
                    }
                    onChange={(e) =>
                      change(
                        event,
                        parseWorkflowPatterns(e.target.value).map((cron) => ({ cron })),
                      )
                    }
                  />
                </ActionField>
              )}
              {enabled && event === "repository_dispatch" && (
                <ActionField label={c.eventTypes} hint={c.anyEventType} className="mt-4">
                  <DraftInput
                    variant="filled"
                    value={Array.isArray(config.types) ? config.types.join(", ") : ""}
                    placeholder="release, content-updated"
                    onChange={(e) => {
                      const values = e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean);
                      update(event, "types", values.length ? values : undefined);
                    }}
                  />
                </ActionField>
              )}
              {enabled && event === "workflow_dispatch" && (
                <div className="mt-4 space-y-3">
                  {Object.entries(object(config.inputs)).map(([name, raw]) => {
                    const input = object(raw),
                      type = String(input.type ?? "string");
                    const edit = (patch: Record<string, unknown>) =>
                      update(event, "inputs", {
                        ...object(config.inputs),
                        [name]: { ...input, ...patch },
                      });
                    return (
                      <div key={name} className="space-y-3 rounded-xl bg-background p-3">
                        <div className="flex items-center justify-between gap-3">
                          <code className="text-xs font-medium">{name}</code>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`${a.remove}: ${name}`}
                            onClick={() => {
                              const values = { ...object(config.inputs) };
                              delete values[name];
                              update(event, "inputs", values);
                            }}
                          >
                            <Icon name="close" />
                          </Button>
                        </div>
                        <div className="grid gap-3 @min-[600px]:grid-cols-2">
                          <ActionField label={c.inputType}>
                            <CustomSelect
                              value={type}
                              variant="filled"
                              triggerClassName="bg-muted/60 hover:bg-muted"
                              options={["string", "boolean", "number", "choice"].map((value) => ({
                                value,
                                label: value,
                              }))}
                              onChange={(type) =>
                                edit({
                                  type,
                                  default:
                                    type === "boolean"
                                      ? false
                                      : type === "number"
                                        ? 0
                                        : type === "choice"
                                          ? "default"
                                          : "",
                                  options: type === "choice" ? ["default"] : undefined,
                                })
                              }
                            />
                          </ActionField>
                          <ActionField label={c.defaultValue}>
                            {type === "boolean" ? (
                              <Checkbox
                                checked={input.default === true}
                                onCheckedChange={(value) => edit({ default: value })}
                              />
                            ) : (
                              <DraftInput
                                variant="filled"
                                type={type === "number" ? "number" : "text"}
                                value={String(input.default ?? "")}
                                onChange={(e) =>
                                  edit({
                                    default:
                                      type === "number" ? Number(e.target.value) : e.target.value,
                                  })
                                }
                              />
                            )}
                          </ActionField>
                        </div>
                        {type === "choice" && (
                          <ActionField label={c.options}>
                            <DraftInput
                              variant="filled"
                              value={Array.isArray(input.options) ? input.options.join(", ") : ""}
                              onChange={(e) =>
                                edit({
                                  options: e.target.value
                                    .split(",")
                                    .map((v) => v.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </ActionField>
                        )}
                        <Input
                          aria-label={c.inputDescription}
                          variant="filled"
                          value={String(input.description ?? "")}
                          placeholder={c.inputDescription}
                          onChange={(e) => edit({ description: e.target.value })}
                        />
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={!!input.required}
                            onCheckedChange={(required) => edit({ required })}
                          />
                          {c.required}
                        </label>
                      </div>
                    );
                  })}
                  <AddInput
                    onAdd={(name) =>
                      update(event, "inputs", {
                        ...object(config.inputs),
                        [name]: { type: "string", required: false },
                      })
                    }
                    existing={Object.keys(object(config.inputs))}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
function AddInput({ onAdd, existing }: { onAdd: (name: string) => void; existing: string[] }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2">
      <DraftInput
        variant="filled"
        value={name}
        aria-label={t.actions.integration.inputName}
        placeholder={t.actions.integration.inputName}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || existing.includes(name)}
        onClick={() => {
          onAdd(name);
          setName("");
        }}
      >
        <Icon name="plus" />
        {t.actions.addValue}
      </Button>
    </div>
  );
}

/** Preserve partially typed separators while the YAML model receives normalized values. */
function useDraftText(
  value: string,
  change: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void,
) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return {
    value: text,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      setText(value);
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(event.target.value);
      change(event);
    },
  };
}
function DraftTextarea({
  value,
  onChange,
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  return <textarea {...props} {...useDraftText(value, onChange)} />;
}
function DraftInput({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  return <Input {...props} {...useDraftText(value, onChange)} />;
}
