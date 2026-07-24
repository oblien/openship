import { PageContainer } from "@/components/ui/PageContainer";
import { serverApi, ServerApiError } from "@/lib/server/api";
import { BillingSidebar, type BillingState } from "./billing-shared";
import { BillingTabBar } from "./BillingTabBar";
import { BillingContent } from "./BillingContent";
import { BillingHeader } from "./BillingHeader";

/** Wire shape of `GET /api/billing/state` — the controller wraps in `{ data }`. */
interface BillingStateEnvelope {
  data: BillingState;
}

/**
 * Fetch the active org's billing snapshot server-side. Returns null when
 * the org isn't configured for billing (404) or any other API error — the
 * caller renders the layout without a sidebar in that case rather than
 * failing the whole billing area.
 */
async function fetchBillingState(): Promise<BillingState | null> {
  try {
    const res = await serverApi.get<BillingStateEnvelope>("billing/state", {
      cache: "no-store",
    });
    return res?.data ?? null;
  } catch (err) {
    // 404/501 → SaaS mode, billing not enabled.
    // 403 cloud_not_connected → local mode, no cloud session.
    // 5xx / network → cloud reachable but errored.
    // In all of these the sidebar has nothing to render — fall through to null.
    if (err instanceof ServerApiError) {
      return null;
    }
    // Any other failure (auth, network) — render without sidebar rather
    // than crash the whole billing area. Tabs handle their own error UI.
    return null;
  }
}

export async function BillingLayout({ children }: { children: React.ReactNode }) {
  const state = await fetchBillingState();

  // No billing state — cloud not connected, billing not enabled, or the fetch
  // errored. Don't render the header + tab-bar chrome (and its formatters) above
  // an "unavailable" screen: the tab page renders <BillingUnavailable> with the
  // precise reason. This also keeps billing effectively cloud-gated when reached
  // by direct URL / RSC prefetch (the sidebar link is already hidden).
  if (!state) {
    return <PageContainer className="space-y-6">{children}</PageContainer>;
  }

  return (
    <PageContainer className="space-y-6">
      <BillingHeader state={state} />

      <BillingTabBar />

      <BillingContent sidebar={<BillingSidebar state={state} />}>
        {children}
      </BillingContent>
    </PageContainer>
  );
}
