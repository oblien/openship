"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BillingPendingCheckout } from "@repo/contracts";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { useSession } from "@/lib/auth-client";
import { billingApi } from "@/lib/api/billing";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { useBillingScope } from "./BillingWorkspaceContext";

type PendingCheckouts = {
  workspaceId?: string;
  items: BillingPendingCheckout[];
  count: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markCleared: (id: string) => void;
};

const PendingCheckoutsContext = createContext<PendingCheckouts | null>(null);
export const usePendingCheckouts = () => useContext(PendingCheckoutsContext);

/** Share one read between billing navigation and recovery; never share customer data across scopes. */
export function PendingCheckoutsProvider({
  children,
  workspaceId,
  enabled = true,
}: {
  children: ReactNode;
  workspaceId?: string;
  enabled?: boolean;
}) {
  const scope = useResourceScope();
  const { data: session, isPending } = useSession();
  const { organizationId } = useBillingScope();
  const allowed =
    enabled &&
    !isPending &&
    (!organizationId || organizationId === session?.session.activeOrganizationId);
  return (
    <PendingCheckoutsState
      key={`${scope}:${organizationId ?? ""}:${workspaceId ?? "all"}`}
      workspaceId={workspaceId}
      enabled={allowed}
    >
      {children}
    </PendingCheckoutsState>
  );
}

function PendingCheckoutsState({
  children,
  workspaceId,
  enabled,
}: {
  children: ReactNode;
  workspaceId?: string;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const parent = usePendingCheckouts();
  const clearParent = parent?.markCleared;
  const [items, setItems] = useState<BillingPendingCheckout[]>([]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++revision.current;
    refreshing.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await billingApi.listCheckouts(workspaceId);
      if (!mounted.current || revision.current !== request) return;
      if (!Array.isArray(result?.items)) throw new Error(t.billing.pendingPayments.loadError);
      setItems(result.items);
    } catch (err) {
      if (mounted.current && revision.current === request)
        setError(getApiErrorMessage(err, t.billing.pendingPayments.loadError));
    } finally {
      if (mounted.current && revision.current === request) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, [enabled, workspaceId, t.billing.pendingPayments.loadError]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Returning from hosted checkout updates both the list and its navigation badge.
    const onFocus = () => {
      if (document.visibilityState === "visible" && !refreshing.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      revision.current++;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  const markCleared = useCallback(
    (id: string) => {
      setClosed((previous) => new Set(previous).add(id));
      // Scoped recovery dialogs also clear the organization's navigation count.
      clearParent?.(id);
    },
    [clearParent],
  );
  return (
    <PendingCheckoutsContext.Provider
      value={{
        workspaceId,
        items: enabled ? items : [],
        loading: enabled && loading,
        error: enabled ? error : null,
        refresh,
        markCleared,
        count: enabled ? items.filter((item) => !closed.has(item.id)).length : 0,
      }}
    >
      {children}
    </PendingCheckoutsContext.Provider>
  );
}
