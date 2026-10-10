"use client";
import { useState } from "react";
import type { ActionRunnerView } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { RunnerSetupDialog } from "./RunnerEditor";
import { ActionBudgetDialog } from "./ActionBudget";

interface Props {
  runners: ActionRunnerView[];
  value: string[];
  onChange: (ids: string[]) => void;
  onCreated: (runner: ActionRunnerView) => void;
  refresh: () => void;
}

export function WorkflowRunnerSelect(props: Props) {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const a = t.actions;
  const c = a.completion;
  const [open, setOpen] = useState<"choose" | "create" | "cloud" | null>(null);
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
        <Icon name="server" className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {selected.length === 1
              ? selected[0]!.name
              : selected.length
                ? interpolate(c.selectedRunners, { count: String(selected.length) })
                : c.chooseRunners}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {selected.length === 1 ? selected[0]!.labels.join(" · ") : c.runnerHint}
          </span>
        </span>
        <Icon
          name={props.runners.length ? "chevron-down" : "plus"}
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
      {!selfHosted && (
        <Button variant="ghost" size="sm" className="-ms-2" onClick={() => setOpen("cloud")}>
          <Icon name="cloud" />
          {a.setup.prepareCloud}
        </Button>
      )}
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
      {open === "cloud" && (
        <ActionBudgetDialog
          onClose={() => {
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
            <label
              key={runner.id}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${optionCardSurface(value.includes(runner.id))}`}
            >
              <Checkbox
                checked={value.includes(runner.id)}
                disabled={!runner.enabled && !value.includes(runner.id)}
                onCheckedChange={(checked) =>
                  onChange(checked ? [...value, runner.id] : value.filter((id) => id !== runner.id))
                }
              />
              <Icon
                name={
                  runner.kind === "cloud"
                    ? "cloud"
                    : runner.capabilities?.os === "macos"
                      ? "apple"
                      : "server"
                }
                className="size-5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{runner.name}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {runner.labels.join(" · ")}
                </span>
              </span>
              {!runner.enabled && (
                <span className="text-xs text-muted-foreground">{c.runnerDisabled}</span>
              )}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
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
