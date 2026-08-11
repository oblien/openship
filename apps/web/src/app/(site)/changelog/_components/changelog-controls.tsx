"use client";

import { useEffect, useState } from "react";

/**
 * The list's toolbar. Two jobs, both DOM-only — it never receives entry data, so
 * collapsing the page costs no extra client payload:
 *
 *  - Expand/collapse every tier at once. Worth having because a closed `<details>`
 *    is invisible to find-in-page in browsers that don't auto-expand it, so this is
 *    the escape hatch for "Ctrl+F the whole changelog".
 *  - Open the tiers a `#slug` deep link names. Landing on a collapsed entry would
 *    otherwise show only its header row.
 */
export function ChangelogControls({ releaseCount }: { releaseCount: number }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const openHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      // The id may sit on the entry wrapper (open the version inside it) or on
      // something nested inside a collapsed tier (open its ancestors).
      target.querySelector("details")?.setAttribute("open", "");
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true;
      }
      target.scrollIntoView({ block: "start" });
    };

    openHash();
    window.addEventListener("hashchange", openHash);
    return () => window.removeEventListener("hashchange", openHash);
  }, []);

  function toggleAll() {
    const next = !expanded;
    document
      .querySelectorAll<HTMLDetailsElement>(".cl-list details")
      .forEach((d) => (d.open = next));
    setExpanded(next);
  }

  return (
    <div className="cl-toolbar">
      <span className="cl-toolbar-count">
        {releaseCount} {releaseCount === 1 ? "release" : "releases"}
      </span>
      <button type="button" onClick={toggleAll} className="cl-btn" aria-pressed={expanded}>
        {expanded ? "Collapse all" : "Expand all"}
      </button>
    </div>
  );
}
