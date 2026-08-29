"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Boxes, Copy, Loader2, Server, Trash2 } from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { SlidingToggle } from "@/components/ui/SlidingToggle";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { Choice } from "@/components/ui/Choice";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi } from "@/lib/api/services";
import { dockerMigrationApi } from "@/lib/api/server-migration";

/**
 * Move this project to another server — the BODY of the Advanced tab's Migration card.
 *
 * Body only, not the card: the surrounding chrome is `AdvancedSettings`' own `SectionCard`,
 * so this sits in the same bordered, titled box as Project Status and Routing rather than
 * inventing a second card style next to them.
 *
 * It lives in a COLLAPSED full-width section, which is what lets the whole decision —
 * from, to, move-or-duplicate, and (for a duplicate) which services — sit on one line
 * instead of stacking into a column the operator scrolls.
 *
 * The flow is deliberately short: choose, confirm, and you are IN the migration session.
 *
 * The confirm dialog is local — it restates the choice and the two things a run cannot fix
 * (downtime, and DNS still pointing at the old host) from what is already on screen. It does
 * not plan. Planning means an SSH scan of the source, which is seconds of work that can fail
 * on an unreachable host, and doing it before the operator has even agreed put a whole
 * waiting flow in front of the flow that already exists. It now happens in the run's
 * `adopting` phase, where its progress and any failure land in the session's own log and the
 * run is retryable and resumable.
 *
 * Progress is NOT here. Starting hands the run id up via {@link onStarted} and the parent
 * swaps in the ordinary migration run panel — the same one the server's Migrations tab opens
 * a row into. There is no project-specific progress, log, cutover or rollback UI.
 */
export function ProjectMigrationCard({
  projectId,
  projectName,
  sourceServerId,
  sourceServerName,
  onStarted,
  initialIntent = "move",
}: {
  projectId: string;
  projectName: string;
  /** The server the project runs on today. */
  sourceServerId: string;
  sourceServerName?: string | null;
  /** Called with the new run's id once the move has started. */
  onStarted: (runId: string) => void;
  /**
   * Which mode the card opens in. Exists so a static render can exercise the DUPLICATE
   * subtree — the branch that reads the service scope, and the one a move-only test can
   * never reach because `intent` is internal state with no other way in.
   */
  initialIntent?: "move" | "copy";
}) {
  const { t } = useI18n();
  const mg = t.projectSettings.advanced.migration;
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();

  // The whole selected server, not just its id: the confirm modal names the destination,
  // and `ServerSelector` hands back the full option so there is nothing to look up.
  const [target, setTarget] = useState<ServerOption | null>(null);
  // "move" first, and the default: it is what the card is titled, and the destructive
  // reading of an unchanged control should be the one the operator came for.
  const [intent, setIntent] = useState<"move" | "copy">(initialIntent);
  // Rows, not bare names: the volume count is what an operator needs beside a service name
  // here, because it decides how long the copy takes and whether data comes with it.
  const [services, setServices] = useState<Array<{ name: string; volumes: number }> | null>(
    null,
  );
  // EMPTY = every service, which is why the checkboxes render as all-checked while it is.
  // Sent as `undefined` so the server reads "whole project" rather than an explicit list
  // that happens to be complete — the two mean the same thing but only one survives a
  // service being added between the plan and the run.
  const [scoped, setScoped] = useState<Set<string>>(() => new Set());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void servicesApi
      .list(projectId)
      .then((res) =>
        setServices(
          res.services
            .filter((svc) => svc.name)
            .map((svc) => ({ name: svc.name, volumes: svc.volumes?.length ?? 0 })),
        ),
      )
      .catch(() => setServices([]));
  }, [projectId]);

  /** Toggle one service. Going from "all" to a narrowed set starts from every OTHER
   *  service, so the first click subtracts the one clicked rather than selecting only it —
   *  which is what an all-checked list implies. */
  const toggleService = useCallback(
    (name: string) => {
      setScoped((prev) => {
        if (prev.size === 0) {
          return new Set((services ?? []).map((s) => s.name).filter((n) => n !== name));
        }
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        // Back to everything → back to the "all" sentinel, so the request stays
        // scope-free.
        return next.size === (services ?? []).length ? new Set() : next;
      });
    },
    [services],
  );

  // Only a COPY may narrow, and an empty set means "everything" — so both collapse to
  // `undefined`, the one value that keeps the plan and the run agreeing about the whole
  // project even if a service is added between them.
  const scopeForRequest = useMemo(
    () => (intent === "copy" && scoped.size > 0 ? [...scoped] : undefined),
    [intent, scoped],
  );

  /**
   * Start the run, then hand its id up so the tab shows the migration SESSION.
   *
   * There is no plan fetch in front of this any more, and that is the point. Resolving what
   * would move means an SSH scan of the source: seconds of work that can fail on an
   * unreachable host. Doing it here left the operator on a dead "Checking…" button and then
   * a toast — a whole flow of its own, in front of the flow that already exists. It now
   * happens in the run's `adopting` phase, so the scan, its progress, and its failure reason
   * all appear in the session's own log, where the run can be retried or resumed.
   *
   * Nothing irreversible precedes the session: a move parks at `awaiting_cutover` with the
   * source stopped but intact, and a duplicate never touches the original at all.
   */
  const start = useCallback(async () => {
    if (!target) return;
    setStarting(true);
    try {
      const res = await dockerMigrationApi.startProjectMove({
        projectId,
        targetServerId: target.id,
        intent,
        serviceNames: scopeForRequest,
      });
      onStarted(res.migrationId);
    } catch (err) {
      // Only the free refusals reach here (Cloud-hosted, same server, a scoped move) — the
      // server answers those without touching a host, so this is fast and specific.
      //
      // Through `getApiErrorMessage`, NOT `err.message`. An `ApiError`'s own message is the
      // status line — literally `API 400: Bad Request` — and the reason the server took the
      // trouble to write (`"clincai" already runs on that server.`) sits in `err.body.error`,
      // which only this helper reads. Every refusal in this flow is a sentence worth showing;
      // reading `.message` threw all of them away and showed the operator a status code.
      showToast(getApiErrorMessage(err, mg.startFailed), "error", mg.title);
    } finally {
      setStarting(false);
    }
  }, [projectId, target, intent, scopeForRequest, onStarted, showToast, mg]);

  const targetName = target?.name ?? "";

  /**
   * The confirm — through `showModal`, the same hook every other destructive confirm in the
   * app uses (remove server, disconnect GitHub, delete a draft project). It brings the shared
   * chrome: title, message, and buttons whose VARIANT carries the weight of the action.
   *
   * That variant is the part a hand-rolled dialog got wrong. A move removes containers from
   * the old server, so its button is `danger`; a duplicate touches nothing that exists, so its
   * button is `primary`. Two different acts should not look identical.
   *
   * No spinner and no local open/closed state: the renderer closes on a non-secondary click,
   * and what happens next is the session taking over the tab.
   */
  const confirm = useCallback(() => {
    if (!target) return;
    const id = showModal({
      title: interpolate(intent === "move" ? mg.confirmTitle : mg.confirmTitleCopy, {
        project: projectName,
        server: target.name,
      }),
      // The two things the run cannot fix, plus what is about to happen. One paragraph
      // because that is the slot the shared dialog gives, and these are three short
      // sentences rather than a form.
      message: [
        mg.confirmSubtitle,
        intent === "move" ? mg.downtimeNote : mg.downtimeNoteCopy,
        intent === "move" ? mg.dnsNote : mg.copyNoDomainsNote,
      ].join(" "),
      icon: "warning",
      // WITHOUT this the dialog is 80vw — the renderer's default, which is meant for the
      // wide content modals (a service table, a log). A confirm that inherits it stretches
      // to ~2300px on a desktop and its two buttons stretch with it. Every other confirm in
      // the app passes its own width for the same reason; 480px is the one they use.
      maxWidth: "480px",
      buttons: [
        { label: mg.cancel, variant: "secondary", onClick: () => hideModal(id) },
        {
          label: intent === "move" ? mg.confirmStart : mg.confirmStartCopy,
          variant: intent === "move" ? "danger" : "primary",
          onClick: () => void start(),
        },
      ],
    });
  }, [target, intent, projectName, mg, showModal, hideModal, start]);

  return (
    <div className="space-y-4">
      {/* ── Where ── two boxes of the SAME construction, so they line up by definition
          rather than by matched magic numbers. "From" is a read-only mirror of the
          selector's own row (same padding, same 8×8 icon tile, same two-line body): one
          control answering "which server", in two states. Trying to align a 36px-tall
          custom row against the selector's ~56px is what made the first pass look broken. */}
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{mg.fromLabel}</p>
          <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3.5 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Server className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {sourceServerName || mg.currentServer}
              </p>
              {/* The service count, not "Current server" — that would restate the "From"
                  label directly above it. It also gives this box the selector's two-line
                  body, which is what makes the two the same height without a magic
                  min-height. */}
              <p className="text-xs text-muted-foreground">
                {services === null
                  ? "—"
                  : interpolate(mg.sourceServices, { count: String(services.length) })}
              </p>
            </div>
          </div>
        </div>

        {/* Centred against the boxes, not the column: the label above them is 11px + a
            6px gap, so the arrow drops by half a box height minus that. */}
        <ArrowRight className="mx-auto mb-5 hidden size-4 shrink-0 text-muted-foreground sm:block" />

        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{mg.toLabel}</p>
          {/* The SHARED server selector — the same control the deploy wizard, mail setup
              and adopt-mail use. Its own docs name this flow ("flows that must not guess
              (adopt / migrate)"), so it is not a coincidence that it fits: it brings the
              masked host line, the loading and empty states, and an add-server row inside
              its own menu, so an operator with one server can create the destination here
              instead of hitting a dead end. */}
          <ServerSelector
            compact
            value={target?.id ?? null}
            onSelect={setTarget}
            excludeIds={[sourceServerId]}
            emptyHint={mg.noOtherServers}
          />
        </div>
      </div>

      {/* ── How ── mode on the left, the action on the right, both vertically centred on
          one line. `SlidingToggle`, not `PillSwitcher`: the latter outlines every option,
          which reads as two buttons rather than one control with a chosen side. This is the
          product's own segmented control — a quiet track with the selection carried by a
          filled pill that slides. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SlidingToggle
          value={intent}
          onChange={setIntent}
          variant="square"
          size="sm"
          backgroundColor="bg-muted/40"
          options={[
            { value: "move" as const, label: mg.intentMove },
            { value: "copy" as const, label: mg.intentCopy },
          ]}
        />

        <button
          type="button"
          onClick={confirm}
          disabled={!target}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {intent === "move" ? mg.migrate : mg.duplicate}
        </button>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {intent === "move" ? (
          <Trash2 className="mt-0.5 size-3 shrink-0" />
        ) : (
          <Copy className="mt-0.5 size-3 shrink-0" />
        )}
        <span>{intent === "move" ? mg.intentMoveHint : mg.intentCopyHint}</span>
      </p>

      {/* ── Service scope ── DUPLICATE only, and that asymmetry is the data model: a
          project is bound to ONE server (`project.serverId`), so moving a subset would
          leave a project with containers on two hosts and nowhere to record where it
          lives. The server refuses a scoped move; not offering it here is the same rule,
          stated before the operator can trip over it. */}
      {intent === "copy" && (
        <div className="rounded-xl bg-muted/25 p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Boxes className="size-3.5 text-muted-foreground" />
              <p className="text-[12px] font-medium text-foreground">{mg.scopeLabel}</p>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {scoped.size === 0 ? (services?.length ?? 0) : scoped.size}
                {"/"}
                {services?.length ?? 0}
              </span>
            </div>
            {/* Only offered once a narrowing exists to undo — a "Select all" that is
                already true is a control that does nothing. */}
            {scoped.size > 0 && (
              <button
                type="button"
                onClick={() => setScoped(new Set())}
                className="rounded-lg px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
              >
                {mg.scopeAll}
              </button>
            )}
          </div>
          {services === null ? (
            <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {services.map((svc) => (
                <Choice
                  key={svc.name}
                  // Empty selection means "everything", so every row reads as checked
                  // until the operator narrows it — otherwise the default (copy the whole
                  // project) would render as nothing selected.
                  checked={scoped.size === 0 || scoped.has(svc.name)}
                  onToggle={() => toggleService(svc.name)}
                  label={svc.name}
                  // The volume count, not the image tag: it is the part that decides how
                  // long this copy takes and whether data comes with it. A stateless
                  // service says nothing rather than "0 volumes", which reads as a fault.
                  hint={
                    svc.volumes > 0
                      ? interpolate(mg.svcVolumes, { count: String(svc.volumes) })
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <p className="mt-2.5 text-[11px] text-muted-foreground">
            {scoped.size === 0
              ? mg.scopeHintAll
              : interpolate(mg.scopeHintSome, { count: String(scoped.size) })}
          </p>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">{mg.cloudLater}</p>

    </div>
  );
}
