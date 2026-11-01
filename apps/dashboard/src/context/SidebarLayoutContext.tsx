"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const SidebarLayoutContext = createContext({
  autoCollapse: false,
  requestCollapse: (): (() => void) => () => {},
});

/** Page content reports its width needs without refetching data in navigation. */
export function SidebarLayoutProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState(0);
  const requestCollapse = useCallback(() => {
    setRequests((count) => count + 1);
    return () => setRequests((count) => count - 1);
  }, []);
  const value = useMemo(
    () => ({ autoCollapse: requests > 0, requestCollapse }),
    [requests, requestCollapse],
  );
  return <SidebarLayoutContext.Provider value={value}>{children}</SidebarLayoutContext.Provider>;
}

export function useSidebarLayout() {
  return useContext(SidebarLayoutContext);
}

/** Release only this component's request when its layout changes or it unmounts. */
export function useSidebarCollapseRequest(enabled: boolean) {
  const { requestCollapse } = useSidebarLayout();
  useLayoutEffect(() => {
    if (enabled) return requestCollapse();
  }, [enabled, requestCollapse]);
}
