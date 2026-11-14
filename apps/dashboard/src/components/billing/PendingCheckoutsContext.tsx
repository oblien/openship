"use client";

import { reportCaughtError } from "@repo/core/diagnostics";
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
import { managementApi } from "@/lib/api/management";
import { subscriptionNeedsPayment } from "@/lib/billing-presentation";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useI18n } from "@/components/i18n-provider";
import { useBillingScope } from "./BillingWorkspaceContext";
import { PAYMENTS_CHANGED } from "@/lib/billing-events";

type PendingCheckouts = {
  workspaceId?: string;
  items: BillingPendingCheckout[];
  count: number;
  attentionCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markCleared: (id: string) => void;
};

const PendingCheckoutsContext = createContext<PendingCheckouts | null>(null);
export const usePendingCheckouts = () => useContext(PendingCheckoutsContext);

/** One organization-wide payment read supplies the rail and billing hub. */
export function DashboardPaymentsProvider({ children }: { children: ReactNode }) {
  const { selfHosted, deployMode } = usePlatform();
  const { connected } = useCloud();
  return <PendingCheckoutsProvider enabled={(!selfHosted && deployMode !== "desktop") || connected} includeManagement>
    {children}
  </PendingCheckoutsProvider>;
}

/** Share one read between billing navigation and recovery; never share customer data across scopes. */
export function PendingCheckoutsProvider({
  children,
  workspaceId,
  enabled = true,
  includeManagement = false,
}: {
  children: ReactNode;
  workspaceId?: string;
  enabled?: boolean;
  includeManagement?: boolean;
}) {
  const scope = useResourceScope();
  const { data: session, isPending } = useSession();
  const { organizationId } = useBillingScope();
  const parent = usePendingCheckouts();
  const allowed =
    enabled &&
    !isPending &&
    (!organizationId || organizationId === session?.session.activeOrganizationId);
  if (parent && parent.workspaceId === workspaceId && allowed && !includeManagement) return children;
  return (
    <PendingCheckoutsState
      key={`${scope}:${organizationId ?? ""}:${workspaceId ?? "all"}:${allowed}`}
      workspaceId={workspaceId}
      enabled={allowed}
      waiting={enabled && isPending}
      includeManagement={includeManagement}
    >
      {children}
    </PendingCheckoutsState>
  );
}

function PendingCheckoutsState({
  children,
  workspaceId,
  enabled,
  waiting,
  includeManagement,
}: {
  children: ReactNode;
  workspaceId?: string;
  enabled: boolean;
  waiting?: boolean;
  includeManagement: boolean;
}) {
  const { t } = useI18n();
  const parent = usePendingCheckouts();
  const clearParent = parent?.markCleared;
  const [items, setItems] = useState<BillingPendingCheckout[]>([]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [managementPending, setManagementPending] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++revision.current;
    refreshing.current = true;
    setLoading(true);
    setError(null);
    if (includeManagement) {
      // Keep compute recovery usable if this account cannot read Manage billing.
      void managementApi.get().then(state => {
        if (mounted.current && revision.current === request) setManagementPending(Boolean(
          state.pendingCheckout || state.change?.paymentUrl || subscriptionNeedsPayment(state.subscription?.status),
        ));
      }).catch(error => {
        reportCaughtError(error, "dashboard/components/billing/PendingCheckoutsContext");
      });
    }
    try {
      const result = await billingApi.listCheckouts(workspaceId);
      if (!mounted.current || revision.current !== request) return;
      if (!Array.isArray(result?.items)) throw new Error(t.billing.pendingPayments.loadError);
      if (workspaceId && result.items.some((item) => item.server.id !== workspaceId))
        throw new Error(t.billing.pendingPayments.loadError);
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
  }, [enabled, workspaceId, includeManagement, t.billing.pendingPayments.loadError]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Returning from hosted checkout updates both the list and its navigation badge.
    const onFocus = () => {
      if (document.visibilityState === "visible" && !refreshing.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    const onChanged = () => { void refresh(); };
    window.addEventListener(PAYMENTS_CHANGED, onChanged);
    return () => {
      mounted.current = false;
      revision.current++;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PAYMENTS_CHANGED, onChanged);
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
        loading: Boolean(waiting) || (enabled && loading),
        error: enabled ? error : null,
        refresh,
        markCleared,
        count: enabled ? items.filter((item) => !closed.has(item.id)).length : 0,
        attentionCount: enabled ? new Set(items.filter(item => !closed.has(item.id)).map(item => item.server.id)).size + Number(managementPending) : 0,
      }}
    >
      {children}
    </PendingCheckoutsContext.Provider>
  );
}
