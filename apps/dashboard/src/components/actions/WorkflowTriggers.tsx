"use client";
import { useState } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Checkbox } from "@/components/ui/Checkbox";
import { DraftInput } from "./DraftText";
import { Switch } from "@/components/ui/Switch";
import { WorkflowPatterns, WorkflowPatternFilter } from "./WorkflowPatterns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ActionField } from "./ActionField";
import { ActionError } from "./ActionStatus";
import {
  editWorkflowTrigger,
  workflowTriggers,
  workflowEventConfig as object,
  type WorkflowEvent,
} from "./workflow-yaml";

export function WorkflowTriggers({
  source,
  onChange,
  standalone,
  embedded = false,
  onEditYaml,
}: {
  source: string;
  onChange: (source: string) => void;
  standalone: boolean;
  embedded?: boolean;
  onEditYaml: () => void;
}) {
  const { t } = useI18n();
  const a = t.actions,
    c = a.integration;
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<WorkflowEvent | null>(null);
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
  const events: Array<{ event: WorkflowEvent; label: string; hint: string; icon: IconName }> = [
    { event: "workflow_dispatch", label: c.manual, hint: c.manualHint, icon: "play" },
    ...(!standalone
      ? [
          { event: "push" as const, label: c.push, hint: c.pushHint, icon: "git-commit" as const },
          {
            event: "pull_request" as const,
            label: c.pullRequest,
            hint: c.pullRequestHint,
            icon: "git-fork" as const,
          },
        ]
      : []),
    {
      event: "schedule",
      label: c.schedule,
      hint: standalone ? c.standaloneScheduleHint : c.scheduleHint,
      icon: "clock",
    },
    { event: "repository_dispatch", label: c.webhook, hint: c.webhookHint, icon: "webhook" },
  ];
  return (
    <section
      className={embedded ? "@container space-y-4" : "@container space-y-4 rounded-2xl bg-card p-5"}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon name="bolt" className="size-4 text-muted-foreground" />
        {c.triggers}
      </h2>
      <ActionError message={error} />
      <div className="space-y-2">
        {Object.keys(triggers)
          .filter((event) => !events.some((item) => item.event === event))
          .map((event) => (
            <button
              key={event}
              type="button"
              onClick={onEditYaml}
              className="flex w-full items-center gap-2.5 rounded-xl bg-muted/30 px-3 py-3 text-start focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon name="code" className="size-4 shrink-0 text-muted-foreground" />
              <code className="min-w-0 flex-1 truncate text-xs">{event}</code>
              <span className="text-xs text-muted-foreground">{t.actions.editor.yaml}</span>
              <Icon
                name="chevron-right"
                className="size-3.5 text-muted-foreground rtl:rotate-180"
              />
            </button>
          ))}
        {events.map(({ event, label, hint, icon }) => {
          const enabled = Object.hasOwn(triggers, event),
            config = object(triggers[event]),
            open = enabled && expanded === event;
          const toggle = (checked: boolean) => {
            change(
              event,
              checked ? (event === "schedule" ? [{ cron: "0 3 * * *" }] : {}) : undefined,
            );
            setExpanded(checked ? event : null);
          };
          return (
            <div className="rounded-xl bg-muted/30" key={event}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-start focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => (enabled ? setExpanded(open ? null : event) : toggle(true))}
                  aria-expanded={open}
                >
                  <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium">{label}</span>
                  {enabled && (
                    <Icon
                      name="chevron-down"
                      className={`size-3.5 text-muted-foreground ${open ? "rotate-180" : ""}`}
                    />
                  )}
                </button>
                <Switch size="sm" checked={enabled} onChange={toggle} ariaLabel={label} />
              </div>
              {open && (
                <div className="space-y-3 px-3 pb-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
                  {(event === "push" || event === "pull_request") && (
                    <div className="space-y-3">
                      <WorkflowPatternFilter
                        field="branches"
                        label={c.branches}
                        config={config}
                        placeholder="release/**"
                        onChange={(value) => change(event, value)}
                      />
                      <p className="text-xs text-muted-foreground">{c.filterHint}</p>
                      <details className="group/filters">
                        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground">
                          {c.moreFilters}
                          <Icon
                            name="chevron-down"
                            className="size-3.5 group-open/filters:rotate-180"
                          />
                        </summary>
                        <div className="mt-3 space-y-3">
                          <WorkflowPatternFilter
                            field="paths"
                            label={c.paths}
                            config={config}
                            placeholder="src/**"
                            onChange={(value) => change(event, value)}
                          />
                          {event === "push" && (
                            <WorkflowPatternFilter
                              field="tags"
                              label={c.tags}
                              config={config}
                              placeholder="v*"
                              onChange={(value) => change(event, value)}
                            />
                          )}
                          {event === "pull_request" && (
                            <ActionField label={c.eventTypes}>
                              <WorkflowPatterns
                                value={config.types}
                                label={c.eventTypes}
                                placeholder="opened"
                                onChange={(types) =>
                                  update(event, "types", types.length ? types : undefined)
                                }
                              />
                            </ActionField>
                          )}
                        </div>
                      </details>
                    </div>
                  )}
                  {event === "schedule" && (
                    <div className="space-y-2">
                      {(Array.isArray(triggers.schedule) ? triggers.schedule : []).map(
                        (row, index, rows) => (
                          <div key={index} className="flex items-center gap-2">
                            <DraftInput
                              variant="filled"
                              dir="ltr"
                              spellCheck={false}
                              aria-label={`${c.cron} ${index + 1}`}
                              className="font-mono text-xs"
                              value={String(object(row).cron ?? "")}
                              onChange={(e) =>
                                change(
                                  event,
                                  rows.map((value, i) =>
                                    i === index
                                      ? { ...object(value), cron: e.target.value }
                                      : value,
                                  ),
                                )
                              }
                            />
                            <span className="text-xs text-muted-foreground">UTC</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={rows.length === 1}
                              aria-label={`${a.remove}: ${c.cron} ${index + 1}`}
                              onClick={() =>
                                change(
                                  event,
                                  rows.filter((_, i) => i !== index),
                                )
                              }
                            >
                              <Icon name="close" />
                            </Button>
                          </div>
                        ),
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{c.cronHint}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            change(event, [
                              ...(Array.isArray(triggers.schedule) ? triggers.schedule : []),
                              { cron: "0 3 * * *" },
                            ])
                          }
                        >
                          <Icon name="plus" />
                          {c.addSchedule}
                        </Button>
                      </div>
                    </div>
                  )}
                  {event === "repository_dispatch" && (
                    <ActionField label={c.eventTypes} hint={c.anyEventType}>
                      <WorkflowPatterns
                        value={config.types}
                        label={c.eventTypes}
                        placeholder="content-updated"
                        onChange={(types) =>
                          update(event, "types", types.length ? types : undefined)
                        }
                      />
                    </ActionField>
                  )}
                  {event === "workflow_dispatch" && (
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
                          <details key={name} className="group/input rounded-xl bg-background p-3">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                              <code className="text-xs font-medium">{name}</code>
                              <span className="ms-auto text-xs text-muted-foreground">{type}</span>
                              <Icon
                                name="chevron-down"
                                className="size-3.5 text-muted-foreground group-open/input:rotate-180"
                              />
                            </summary>
                            <div className="mt-3 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-muted-foreground">
                                  {a.manualInputs}
                                </span>
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
                                    options={["string", "boolean", "number", "choice"].map(
                                      (value) => ({
                                        value,
                                        label: value,
                                      }),
                                    )}
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
                                            type === "number"
                                              ? Number(e.target.value)
                                              : e.target.value,
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
                                    value={
                                      Array.isArray(input.options) ? input.options.join(", ") : ""
                                    }
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
                          </details>
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
