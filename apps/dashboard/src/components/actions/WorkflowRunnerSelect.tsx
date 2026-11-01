"use client";
import { useId, useState } from "react";
import type { ActionRunnerView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { RunnerSetupDialog } from "./RunnerEditor";
import { RunnerCapabilities, RunnerDetails, RunnerIdentity } from "./RunnerPresentation";

interface Props {
  runners: ActionRunnerView[];
  value: string[];
  onChange: (ids: string[]) => void;
  onCreated: (runner: ActionRunnerView) => void;
  refresh: () => void;
}

export function WorkflowRunnerSelect(props: Props) {
  const { t } = useI18n();
  const a = t.actions;
  const c = a.completion;
  const [open, setOpen] = useState<"choose" | "create" | null>(null);
  const selected = props.runners.filter((runner) => props.value.includes(runner.id));
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{a.destinations}</h2>
        <span className="text-xs text-muted-foreground">{c.required}</span>
      </div>
      <button
        type="button"
        aria-label={a.destinations}
        aria-haspopup="dialog"
        onClick={() => setOpen(props.runners.length ? "choose" : "create")}
        className="flex w-full items-center gap-3 rounded-xl bg-background p-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {selected.length === 1 ? (
          <RunnerIdentity runner={selected[0]!} />
        ) : (
          <Icon name="server" className="size-5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {selected.length === 1
              ? selected[0]!.name
              : selected.length
                ? interpolate(c.selectedRunners, { count: String(selected.length) })
                : c.chooseRunners}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {selected.length === 1 ? (
              <RunnerCapabilities runner={selected[0]!} compact />
            ) : (
              c.runnerHint
            )}
          </span>
        </span>
        <Icon
          name={props.runners.length ? "chevron-down" : "plus"}
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
      {open === "choose" && (
        <RunnerPicker {...props} onCreate={() => setOpen("create")} onClose={() => setOpen(null)} />
      )}
      {open === "create" && (
        <RunnerSetupDialog
          onCancel={() => setOpen(null)}
          onSaved={(runner) => {
            props.onCreated(runner);
            props.onChange([...new Set([...props.value, runner.id])]);
            setOpen(null);
            props.refresh();
          }}
        />
      )}
    </section>
  );
}

function RunnerPicker({
  runners,
  value,
  onChange,
  onCreate,
  onClose,
  refresh,
}: Props & { onCreate: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const a = t.actions;
  const c = a.completion;
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const id = useId();
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      surface="frosted"
      width="560px"
      maxWidth="calc(100vw - 32px)"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={a.destinations}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-5 p-5 outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">{a.destinations}</h2>
          <Button variant="ghost" size="icon" onClick={refresh} aria-label={a.refresh}>
            <Icon name="refresh" />
          </Button>
        </div>
        <div className="max-h-[55dvh] space-y-2 overflow-y-auto">
          {runners.map((runner) => (
            <div
              key={runner.id}
              className={`rounded-xl border ${optionCardSurface(value.includes(runner.id))}`}
            >
              <button
                type="button"
                role="checkbox"
                aria-label={runner.name}
                aria-describedby={`${id}-${runner.id}`}
                aria-checked={value.includes(runner.id)}
                disabled={!runner.enabled && !value.includes(runner.id)}
                onClick={() =>
                  onChange(
                    value.includes(runner.id)
                      ? value.filter((id) => id !== runner.id)
                      : [...new Set([...value, runner.id])],
                  )
                }
                className="flex w-full items-start gap-3 rounded-xl p-3 text-start focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RunnerIdentity runner={runner} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-words text-sm font-medium">{runner.name}</span>
                    {!runner.enabled ? (
                      <span className="text-xs text-muted-foreground">{c.runnerDisabled}</span>
                    ) : runner.error ? (
                      <span className="text-xs text-warning">{a.runnerDetails.checkFailed}</span>
                    ) : null}
                  </span>
                  <span id={`${id}-${runner.id}`} className="mt-1.5 block">
                    <RunnerCapabilities runner={runner} />
                  </span>
                </span>
                <Checkbox checked={value.includes(runner.id)} asButton={false} className="mt-1" />
              </button>
              <div className="px-3 pb-2">
                <RunnerDetails runner={runner} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={onCreate}>
            <Icon name="plus" />
            {a.newRunner}
          </Button>
          <Button onClick={onClose} disabled={!value.length}>
            {c.useRunners}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
