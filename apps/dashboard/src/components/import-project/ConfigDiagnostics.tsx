"use client";

/**
 * #641: an `openship.json` with a typo used to apply nothing — or only some of
 * itself — and say nothing anywhere. The deploy fell back to heuristic detection
 * and succeeded, so the wizard looked exactly as if the file weren't there. The
 * leniency is right (a bad config must not refuse a repo); the silence wasn't.
 *
 * Outside every type-specific section on purpose: a refused field can belong to
 * any of them, and the notice must not vanish when applying a compose path flips
 * the wizard to `services` — same reason `<ComposePathField />` sits out there.
 *
 * `wholeFile` splits the copy because the two severities are genuinely different:
 * bad JSON means NOTHING applied, a refused field means the rest still did. The
 * list items themselves come from the parser in @repo/core and are untranslated.
 */
import React from "react";
import { FileWarning } from "lucide-react";
import WarningCallout from "@/components/shared/WarningCallout";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";

export const ConfigDiagnostics: React.FC = () => {
  const deployment = useOptionalDeployment();
  const { t } = useI18n();

  const diag = deployment?.config?.configDiagnostics;
  const errors = diag?.errors ?? [];
  const warnings = diag?.warnings ?? [];
  if (errors.length === 0 && warnings.length === 0) return null;

  const cd = t.importProject.configDiagnostics;
  const wholeFile = diag?.wholeFile === true;

  return (
    <WarningCallout
      icon={FileWarning}
      title={wholeFile ? cd.titleWholeFile : cd.title}
      description={wholeFile ? cd.descriptionWholeFile : cd.description}
    >
      <div className="mt-3 space-y-3">
        {errors.length > 0 && <DiagnosticList label={cd.refused} items={errors} tone="danger" />}
        {warnings.length > 0 && (
          <DiagnosticList label={cd.unrecognized} items={warnings} tone="muted" />
        )}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{cd.hint}</p>
    </WarningCallout>
  );
};

const DiagnosticList: React.FC<{
  label: string;
  items: string[];
  tone: "danger" | "muted";
}> = ({ label, items, tone }) => (
  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
      {label}
    </p>
    <ul className="mt-1.5 list-disc space-y-1 ps-5">
      {items.map((item, i) => (
        <li
          // The parser can emit the same message twice (e.g. two bad entries in
          // one array), so the index is part of the key.
          key={`${i}-${item}`}
          className={`break-words font-mono text-[11.5px] leading-relaxed ${
            tone === "danger" ? "text-danger" : "text-muted-foreground"
          }`}
        >
          {item}
        </li>
      ))}
    </ul>
  </div>
);

export default ConfigDiagnostics;
