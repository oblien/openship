"use client";

import { useState } from "react";

/** Keep the normal sidebar preference separate from a canvas page's temporary override. */
export function useSidebarCollapse(autoCollapse: boolean) {
  const [state, setState] = useState({
    autoCollapse,
    preferredCollapsed: false,
    override: null as boolean | null,
  });

  // Reset on entering or leaving the canvas, before children paint at the old width.
  if (state.autoCollapse !== autoCollapse) {
    setState({ ...state, autoCollapse, override: null });
  }

  const collapsed = autoCollapse ? (state.override ?? true) : state.preferredCollapsed;
  const toggleCollapsed = () => {
    setState((current) =>
      autoCollapse
        ? { ...current, override: !(current.override ?? true) }
        : { ...current, preferredCollapsed: !current.preferredCollapsed },
    );
  };

  return { collapsed, toggleCollapsed };
}
