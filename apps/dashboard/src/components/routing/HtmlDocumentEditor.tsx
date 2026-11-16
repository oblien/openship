"use client";

import { useRef, useState } from "react";
import { EDGE_RESPONSE_MAX_BYTES, normalizeEdgeHtml } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Shared literal-HTML editor. Preview has an opaque origin, no scripts or network. */
export function HtmlDocumentEditor({
  value,
  onChange,
  disabled,
  hint,
  rows = 10,
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  hint?: string;
  rows?: number;
}) {
  const { t } = useI18n();
  const w = t.widgets.routing.pages;
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{w.html}</span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            <Icon name="upload" size={16} />
            {w.upload}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPreview(!preview)}>
            {preview ? w.edit : w.preview}
          </Button>
        </div>
      </div>
      <input
        ref={file}
        type="file"
        accept=".html,.htm,text/html"
        className="hidden"
        disabled={disabled}
        aria-label={w.upload}
        onChange={async (event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (!selected) return;
          try {
            if (selected.size > EDGE_RESPONSE_MAX_BYTES) throw new Error(w.sizeLimit);
            onChange(normalizeEdgeHtml(await selected.text()));
            setError("");
          } catch (error) {
            reportCaughtError(error, "dashboard/edge-pages/html-upload");
            setError(w.sizeLimit);
          }
        }}
      />
      {preview ? (
        <div className="space-y-2">
          <iframe
            title={w.preview}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-72 w-full rounded-xl bg-white"
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">${value}`}
          />
          <p className="text-xs text-muted-foreground">{w.previewHint}</p>
        </div>
      ) : (
        <textarea
          aria-label={w.html}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          spellCheck={false}
          dir="ltr"
          rows={rows}
          className="w-full resize-y rounded-xl bg-background p-4 font-mono text-xs leading-6 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      <p className="text-xs text-muted-foreground">{hint ?? w.sizeLimit}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
