import type { ReactNode } from "react";

/** Keep supplementary procedures in the document, keyboard accessible and searchable. */
export function DocsDetails({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="docs-details">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
