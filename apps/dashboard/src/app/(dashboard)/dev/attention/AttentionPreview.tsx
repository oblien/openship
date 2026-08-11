"use client";

/**
 * Variant switcher around the home attention cards, driven entirely by fixtures.
 *
 * These cards only render when real infrastructure is broken or behind, so the only
 * way to review their layout used to be stopping a container on a live box — which is
 * how they ended up flatter than the product tip they replace.
 *
 * They read the same feed `/issues` does and split it by the severity the server
 * assigned, so the fixtures are the feed's fixtures and the variants here are the
 * SPLIT worth checking rather than a second catalogue of rows:
 *
 *   outage    — the danger card, over cap: 4 rows in a 3-row list, one of them a
 *               gone mail engine that must NOT offer a fix
 *   action    — nothing down: the same card at warning, with Install and a countdown
 *   advisory  — the amber updates card: control plane via CLI, drift via Update
 *   mixed     — both cards, which is what an operator actually sees mid-incident
 *
 * Hiding works here too, but only in local state: the real button writes a fingerprint
 * to localStorage, and a preview that could hide your actual home cards would be a
 * trap. Switching variant brings a hidden card back.
 */

import { useState } from "react";

import { ISSUE_FIXTURES } from "@/components/issues/issue-fixtures";
import { IssuesCard, UpdatesCard } from "@/components/overview/AttentionCards";
import type { AttentionCardKey } from "@/lib/attention-hide";

type Variant = "outage" | "action" | "advisory" | "mixed";

const VARIANTS: Array<{ id: Variant; label: string; note: string }> = [
  { id: "outage", label: "Outage", note: "4 rows capped at 3 — and a gone mail engine offers no Fix" },
  { id: "action", label: "Action needed", note: "setup gaps, not an outage → warning, not danger" },
  { id: "advisory", label: "Advisory", note: "amber card: CLI for the control plane, Update for drift" },
  { id: "mixed", label: "Both cards", note: "what an operator actually sees mid-incident" },
];

export function AttentionPreview() {
  const [variant, setVariant] = useState<Variant>("outage");
  const [hidden, setHidden] = useState<AttentionCardKey[]>([]);
  const pick = (v: Variant) => {
    setVariant(v);
    setHidden([]);
  };
  const rows = ISSUE_FIXTURES[variant] ?? [];
  const broken = rows.filter((i) => i.severity !== "advisory");
  const behind = rows.filter((i) => i.severity === "advisory");
  const note = VARIANTS.find((v) => v.id === variant)!.note;

  return (
    <div className="space-y-5 p-5">
      <div className="rounded-2xl border border-warning-border bg-warning-bg p-4">
        <p className="text-sm font-medium text-foreground">
          Home attention cards — fixtures, not real data
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Dev-only route; 404s in a production build. Nothing here reads the API and no action
          leaves this page. Check every theme: the severity lives in the border and the header
          strip, which is what makes these outrank the tip card next to them.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => pick(v.id)}
              aria-pressed={variant === v.id}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                variant === v.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground/80">{note}</p>
      </div>

      {/* The real slot is the home right-hand column, and its width is the whole
          design problem — a diagnosis sentence has ~320px, not a page. Reviewing
          these full-width would hide exactly what was wrong with them. */}
      <div className="max-w-[360px] space-y-3">
        {broken.length > 0 && !hidden.includes("broken") && (
          <IssuesCard
            issues={broken}
            busyId={null}
            onResolve={() => {}}
            onInfraFix={() => {}}
            onHide={() => setHidden((h) => [...h, "broken"])}
          />
        )}
        {behind.length > 0 && !hidden.includes("behind") && (
          <UpdatesCard
            issues={behind}
            busyId={null}
            onResolve={() => {}}
            onInfraFix={() => {}}
            onHide={() => setHidden((h) => [...h, "behind"])}
          />
        )}
        {hidden.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Hidden here only. On the home page the column gives a card back per panel
            hidden — the Apps card returns as soon as one is, the Activity overview once
            both are.
          </p>
        )}
      </div>
    </div>
  );
}
