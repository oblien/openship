"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Cloud, ExternalLink, X, Rocket, Shield, Globe, Zap, Loader2 } from "lucide-react";
import { cloudApi } from "@/lib/api";
import { defaultDomainType } from "@/lib/default-domain-type";
import {
  getCloudConnectHandoffUrl,
  generatePkceVerifier,
  computePkceChallenge,
  generateConnectFlowId,
  CONNECT_PKCE_STORAGE_PREFIX,
} from "@/lib/cloud-auth";
import { canUseCloudConnection, usePlatform } from "@/context/PlatformContext";
import { useGitHub } from "@/context/GitHubContext";
import { Button } from "@/components/ui/button";
import { openAuthWindow } from "@/utils/authWindow";
import type { CloudCapability } from "@repo/core";
import { useCloudCapabilityCopy, type CloudRequirementPrompt } from "./cloud/capability-copy";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface CloudUser {
  name: string;
  email: string;
  image?: string | null;
}

interface CloudState {
  /** Whether connected to Openship Cloud */
  connected: boolean;
  /** Cloud user info (available when connected) */
  cloudUser: CloudUser | null;
  /** Whether the initial status check is in flight */
  loading: boolean;
  /** Whether a connect flow is in progress */
  connecting: boolean;
  /**
   * Gate a cloud-requiring action. Resolves `true` immediately when connected
   * (incl. SaaS/native). Otherwise shows the connect modal and resolves once the
   * user acts: `true` after a successful connect (so the caller can PROCEED with
   * no re-trigger), `false` if they dismiss.
   *
   * Pass a `CloudCapability` (copy resolved from the shared registry); a raw
   * prompt object is still accepted for bespoke cases.
   *
   * Usage:
   *   if (!(await requireCloud("cloud-deploy-target"))) return;
   */
  requireCloud: (
    capability: CloudCapability | CloudRequirementPrompt,
    vars?: { domain?: string },
  ) => Promise<boolean>;
  /** Start the cloud connect flow (desktop IPC or browser popup) */
  startConnect: () => void;
  /** Force a status re-check (e.g. after connecting) */
  refresh: () => Promise<void>;
  /** Manually set connected (used by settings callback) */
  setConnected: (v: boolean) => void;
}

/* ------------------------------------------------------------------ */
/*  Context                                                           */
/* ------------------------------------------------------------------ */

const CloudContext = createContext<CloudState | undefined>(undefined);

export function useCloud() {
  const ctx = useContext(CloudContext);
  if (!ctx) throw new Error("useCloud must be used within CloudProvider");
  return ctx;
}

/** {@link defaultDomainType} for components — reads the live Cloud connection. */
export function useDefaultDomainType(): "free" | "custom" {
  return defaultDomainType(useCloud().connected);
}

/* ------------------------------------------------------------------ */
/*  Provider                                                          */
/* ------------------------------------------------------------------ */

const FEATURES = [
  { icon: Rocket, label: "Cloud deployments" },
  { icon: Shield, label: "Managed infrastructure" },
  { icon: Globe, label: "Automatic SSL & domains" },
  { icon: Zap, label: "Global CDN" },
];

export function CloudProvider({ children }: { children: ReactNode }) {
  const { selfHosted, deployMode, cloudAuthUrl, cloudApiUrl } = usePlatform();
  const canConnectCloud = canUseCloudConnection({ selfHosted, deployMode });
  const hasNativeCloudAccess = !canConnectCloud;
  // GitHubProvider is an ancestor of CloudProvider (see providers.tsx),
  // so this consume is always safe. We use it to re-resolve GitHub state
  // whenever the cloud connection flips (below).
  const { refresh: refreshGitHub } = useGitHub();
  const cloudCapabilityCopy = useCloudCapabilityCopy();

  const [connected, setConnected] = useState(false);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [modalFeature, setModalFeature] = useState<CloudRequirementPrompt | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Resolvers for in-flight `requireCloud(...)` promises. A batch (not a single
  // slot) because there's ONE shared modal + connect flow, so concurrent gates
  // legitimately settle together on the same outcome. Drained atomically.
  const pendingRef = useRef<Array<(v: boolean) => void>>([]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Check cloud status on mount (self-hosted / desktop only)
  const checkStatus = useCallback(async () => {
    if (!canConnectCloud) {
      setConnected(true);
      setCloudUser(null);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await cloudApi.status();
      setConnected(res?.connected ?? false);
      setCloudUser(res?.user ?? null);
    } catch {
      setConnected(false);
      setCloudUser(null);
    } finally {
      setLoading(false);
    }
  }, [canConnectCloud]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Listen for the popup's "cloud-connect-success" postMessage so we
  // refresh status the instant the callback page reports finalize OK,
  // rather than waiting for the popup-close poll in startBrowserConnect.
  //
  // First call covers 95% of cases. If that first call somehow comes
  // back disconnected (mount-state race, propagation lag), one
  // delayed retry covers it without spamming the API with three calls
  // per connect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    async function refreshOnce() {
      try {
        const res = await cloudApi.status();
        const isConnected = res?.connected === true;
        setConnected(isConnected);
        setCloudUser(res?.user ?? null);
        return isConnected;
      } catch {
        return false;
      }
    }
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data && typeof e.data === "object" && e.data.type === "cloud-connect-success") {
        void refreshOnce().then((ok) => {
          if (ok) return;
          // First refresh said "still disconnected" — try once more
          // after a settle window in case of a propagation race.
          retryTimer = setTimeout(() => void refreshOnce(), 600);
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  const isConnected = hasNativeCloudAccess || connected;

  // GitHub `cloud-app` mode is backed by the cloud session: connecting or
  // disconnecting Openship Cloud changes which GitHub auth mode resolves
  // and whether a token is available. So whenever the cloud connection
  // TRANSITIONS, re-resolve GitHub state — this is the single wiring point
  // that keeps the GitHub card honest across every connect/disconnect path
  // (settings button, modal, popup postMessage, desktop poll), not just one.
  //
  // The `loading` gate skips the in-flight initial status check so we don't
  // fire a spurious refresh on mount (GitHub already has its SSR data); the
  // first SETTLED value becomes the baseline, and only real changes after
  // that trigger a GitHub refresh.
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (loading) return;
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (prev === null || prev === isConnected) return;
    void refreshGitHub();
  }, [isConnected, loading, refreshGitHub]);

  // Settle every pending requireCloud promise once, then clear the batch
  // atomically (reassign before calling, so a resolver that re-enters can't
  // double-settle). Same settled-guard idea as confirmServerAccess.
  const settlePendingCloud = useCallback((value: boolean) => {
    const resolvers = pendingRef.current;
    pendingRef.current = [];
    resolvers.forEach((resolve) => resolve(value));
  }, []);

  // A successful connect flips `isConnected` true (via checkStatus / the
  // postMessage refresh / the desktop poll). Whichever path gets there, resolve
  // any waiting gates TRUE (so the caller proceeds) and close the modal. Only
  // runs when gates are actually waiting, so a mount where SaaS is already
  // connected is a no-op.
  useEffect(() => {
    if (isConnected && pendingRef.current.length > 0) {
      settlePendingCloud(true);
      setModalFeature(null);
    }
  }, [isConnected, settlePendingCloud]);

  const requireCloud = useCallback(
    (
      capability: CloudCapability | CloudRequirementPrompt,
      vars?: { domain?: string },
    ): Promise<boolean> => {
      if (isConnected) return Promise.resolve(true);
      const prompt =
        typeof capability === "string" ? cloudCapabilityCopy(capability, vars) : capability;
      setModalFeature(prompt);
      return new Promise<boolean>((resolve) => {
        pendingRef.current.push(resolve);
      });
    },
    [isConnected, cloudCapabilityCopy],
  );

  // Dismissing the modal (backdrop / X / "Maybe later") resolves waiting gates
  // FALSE — the single false path, so an abandoned/blocked connect never leaks a
  // pending promise (the modal stays the arbiter while `connecting`).
  const dismissCloudModal = useCallback(() => {
    setModalFeature(null);
    settlePendingCloud(false);
  }, [settlePendingCloud]);

  // Go straight to the SaaS API's handoff endpoint. The handoff itself
  // bounces to /login when the user isn't authenticated there, so this
  // entry point handles BOTH "already signed in" (mint code immediately)
  // and "needs login first" (login page is configured to forward to
  // handoff post-auth via getPostAuthRedirect). Hitting /login first
  // would let (auth)/layout.tsx silently drop the callback param when
  // the SaaS already has a session.
  //
  // The callback URL is the DASHBOARD origin (not the API origin) because
  // the PKCE verifier is stashed in localStorage below, on the dashboard
  // origin. localStorage is per-origin — if the popup lands on the API
  // origin (different port in split-port self-hosted), the verifier is
  // invisible and the PKCE exchange fails on the SaaS side.
  const callbackUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/cloud-connect-callback`
      : "/cloud-connect-callback";

  /** Build the connect handoff URL with a fresh PKCE binding.
   *  Stashes the verifier in localStorage keyed by the flow id (which is
   *  also passed as `state` so the connect-callback popup script can find
   *  it after the round trip). localStorage rather than sessionStorage
   *  because the popup runs in a separate window — sessionStorage is
   *  per-tab/window. */
  const prepareConnectUrl = useCallback(async (): Promise<string> => {
    const flowId = generateConnectFlowId();
    const verifier = generatePkceVerifier();
    const challenge = await computePkceChallenge(verifier);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CONNECT_PKCE_STORAGE_PREFIX + flowId, verifier);
      } catch {
        /* localStorage disabled — fall back to non-PKCE flow */
      }
    }
    return getCloudConnectHandoffUrl(callbackUrl, {
      state: flowId,
      codeChallenge: challenge,
      cloudApiUrl,
    });
  }, [callbackUrl, cloudApiUrl]);

  /** Desktop IPC connect flow with PKCE + nonce polling */
  const startDesktopConnect = useCallback(async () => {
    const desktop = (window as any).desktop;
    if (!desktop?.cloud?.connect) return;

    setConnecting(true);
    try {
      const result = await desktop.cloud.connect();
      if (!result?.ok) {
        setConnecting(false);
        return;
      }

      const nonce = result.nonce;
      let errorCount = 0;

      pollRef.current = setInterval(async () => {
        try {
          const poll = await desktop.cloud.connectPoll(nonce);
          if (poll.status === "resolved") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            await checkStatus();
            setConnecting(false);
          } else if (poll.status === "expired") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(false);
          } else if (poll.status === "error") {
            errorCount++;
            if (errorCount >= 5) {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setConnecting(false);
            }
          }
        } catch {
          errorCount++;
          if (errorCount >= 5) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(false);
          }
        }
      }, 2000);
    } catch {
      setConnecting(false);
    }
  }, [checkStatus]);

  /** Browser popup connect flow */
  const startBrowserConnect = useCallback(() => {
    // Open the popup synchronously from the click handler (about:blank)
    // so browsers don't block it, then navigate it once the async PKCE
    // setup resolves.
    const handle = openAuthWindow();
    prepareConnectUrl()
      .then((url) => handle.navigate(url))
      .catch((error) => {
        // Never silently close the popup. Self-hosted dashboards are often
        // served over private-LAN HTTP, where browser security APIs differ
        // from HTTPS. Keep the window open with an actionable local error if
        // setup still fails after the PKCE fallback.
        console.error("Unable to prepare Openship Cloud sign-in", error);
        handle.navigate(`${window.location.origin}/cloud-connect-callback?setup_error=pkce`);
      });
    handle.onClose(() => checkStatus());
  }, [prepareConnectUrl, checkStatus]);

  /** Start cloud connect - auto-detects desktop vs browser */
  const startConnect = useCallback(() => {
    if (!canConnectCloud) {
      return;
    }

    const isDesktop = typeof window !== "undefined" && (window as any).desktop?.isDesktop;
    if (isDesktop) {
      startDesktopConnect();
    } else {
      startBrowserConnect();
    }
  }, [canConnectCloud, startDesktopConnect, startBrowserConnect]);

  return (
    <CloudContext.Provider
      value={{ connected: isConnected, cloudUser, loading, connecting, requireCloud, startConnect, refresh: checkStatus, setConnected }}
    >
      {children}

      {/* ── Connect Modal ──────────────────────────────────── */}
      {modalFeature && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={dismissCloudModal}
          />

          {/* Panel - solid bg via CSS var so it doesn't ghost out in dark mode
              (the default --th-card-bg is ~2.5% white opacity). */}
          <div
            className="relative mx-4 w-full max-w-md rounded-2xl border border-border p-6 shadow-xl animate-in fade-in zoom-in-95 duration-200"
            style={{ backgroundColor: "var(--th-card-bg-solid, var(--card))" }}
          >
            {/* Close */}
            <button
              onClick={dismissCloudModal}
              className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" />
            </button>

            {/* Icon */}
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/80 to-primary shadow-sm shadow-primary/20">
              <Cloud className="size-7 text-primary-foreground" />
            </div>

            {/* Title */}
            <h2 className="text-lg font-semibold text-foreground">
              Connect Openship Cloud
            </h2>
            {modalFeature.description ? (
              <div className="mt-1 space-y-1.5 text-sm leading-relaxed">
                <p className="text-foreground font-medium">{modalFeature.feature}</p>
                <p className="text-muted-foreground">{modalFeature.description}</p>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                <strong className="text-foreground">{modalFeature.feature}</strong> requires
                an Openship Cloud connection. Connect your account to unlock:
              </p>
            )}

            {modalFeature.secondaryHint && (
              <div className="mt-4 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {modalFeature.secondaryHint}
              </div>
            )}

            {/* Feature list */}
            <div className="mt-4 space-y-2">
              {FEATURES.map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                  <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="size-3.5 text-primary" />
                  </div>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="mt-6 flex flex-col gap-2">
              <Button
                size="lg"
                disabled={connecting}
                onClick={() => {
                  // Keep the modal open in the `connecting` state — it stays the
                  // dismissal arbiter. Success closes it (the isConnected effect);
                  // an abandoned/blocked connect is dismissed → resolves false.
                  startConnect();
                }}
              >
                {connecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                {connecting ? "Waiting for sign in…" : (modalFeature.ctaLabel ?? "Connect to Openship Cloud")}
              </Button>
              <Button
                variant="ghost"
                onClick={dismissCloudModal}
              >
                Maybe later
              </Button>
            </div>
          </div>
        </div>
      )}
    </CloudContext.Provider>
  );
}
