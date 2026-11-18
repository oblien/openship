import type { RuntimeSourcePreview } from "@repo/contracts";
import { useEffect, useId, useRef } from "react";
import { useI18n } from "@/components/i18n-provider";

const diffTones = {
  " ": "text-muted-foreground",
  "−": "bg-danger-bg text-danger",
  "+": "bg-success-bg text-success",
};

/** The source editor changes one line. Include the adjacent lines for context. */
export function RuntimeSourceDiff({ preview }: { preview: RuntimeSourcePreview }) {
  const { t } = useI18n();
  const copy = t.projectSettings.sourceImageUpdate;
  const headingId = useId();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    section.current?.focus();
  }, [preview.reviewId]);
  const before = preview.before.split("\n");
  const after = preview.after.split("\n");
  const changed = before.findIndex((line, index) => line !== after[index]);
  const start = Math.max(0, changed - 2);
  const rows = before.slice(start, changed + 3).flatMap<{
    n: number;
    marker: keyof typeof diffTones;
    line: string;
  }>((line, index) => {
    const i = start + index;
    return line === after[i]
      ? [{ n: i + 1, marker: " ", line }]
      : [
          { n: i + 1, marker: "−", line },
          { n: i + 1, marker: "+", line: after[i] },
        ];
  });

  return (
    <section
      ref={section}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="space-y-2 outline-none"
    >
      <h3 id={headingId} className="text-sm font-medium">
        {copy.diff}
      </h3>
      <div
        aria-label={copy.diff}
        className="overflow-x-auto rounded-xl bg-card py-2 font-mono text-xs leading-6"
        dir="ltr"
      >
        {rows.map(({ n, marker, line }) => (
          <div
            key={`${n}${marker}`}
            className={`grid min-w-max grid-cols-[4ch_2ch_1fr] whitespace-pre px-3 ${diffTones[marker]}`}
          >
            <span aria-hidden="true" className="text-muted-foreground">
              {n}
            </span>
            <span>{marker}</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{copy.review}</p>
    </section>
  );
}
