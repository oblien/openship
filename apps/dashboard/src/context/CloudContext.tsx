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
import { useGitHub } from "@/context/GitHubContext";
import { Button } from "@/components/ui/button";
import { openAuthWindow } from "@/utils/authWindow";

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
   * Call before a cloud-only action. Shows the connect modal if
   * not connected and returns `false`. Returns `true` if connected.
   *
   * Usage:
   *   if (!requireCloud("deploy to cloud")) return;
   */
  requireCloud: (feature: string) => boolean;
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
  const { selfHosted, cloudAuthUrl } = useGitHub();

  const [connected, setConnected] = useState(false);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [modalFeature, setModalFeature] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Check cloud status on mount (self-hosted / desktop only)
  const checkStatus = useCallback(async () => {
    if (!selfHosted) {
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
  }, [selfHosted]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const requireCloud = useCallback(
    (feature: string): boolean => {
      if (connected) return true;
      setModalFeature(feature);
      return false;
    },
    [connected],
  );

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  const connectUrl = `${cloudAuthUrl}/login?callback=${encodeURIComponent(`${apiUrl}/api/cloud/connect-callback`)}`;

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
    const handle = openAuthWindow();
    handle.navigate(connectUrl);
    handle.onClose(() => checkStatus());
  }, [connectUrl, checkStatus]);

  /** Start cloud connect — auto-detects desktop vs browser */
  const startConnect = useCallback(() => {
    const isDesktop = typeof window !== "undefined" && (window as any).desktop?.isDesktop;
    if (isDesktop) {
      startDesktopConnect();
    } else {
      startBrowserConnect();
    }
  }, [startDesktopConnect, startBrowserConnect]);

  return (
    <CloudContext.Provider
      value={{ connected, cloudUser, loading, connecting, requireCloud, startConnect, refresh: checkStatus, setConnected }}
    >
      {children}

      {/* ── Connect Modal ──────────────────────────────────── */}
      {modalFeature && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setModalFeature(null)}
          />

          {/* Panel */}
          <div className="relative mx-4 w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl animate-in fade-in zoom-in-95 duration-200">
            {/* Close */}
            <button
              onClick={() => setModalFeature(null)}
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
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground">{modalFeature}</strong> requires
              an Openship Cloud connection. Connect your account to unlock:
            </p>

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
                  setModalFeature(null);
                  startConnect();
                }}
              >
                {connecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                {connecting ? "Waiting for sign in…" : "Connect to Openship Cloud"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setModalFeature(null)}
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
