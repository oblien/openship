"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { CloudSupportSession } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/PageContainer";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { ApiError, getApiErrorCode } from "@/lib/api/client";
import {
  createCloudSupportApi,
  getCloudSupportSession,
  type CloudSupportApi,
} from "@/lib/api/cloud-support";

type Account = NonNullable<CloudSupportSession["account"]>;
type Inbox = (account: Account, client: CloudSupportApi) => ReactNode;

export function LinkedSupportCenter({ children }: { children: Inbox }) {
  const { connected, loading, cloudUser } = useCloud();
  const { t } = useI18n();
  if (loading && !connected)
    return (
      <PageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          {t.support.checkingConnection}
        </p>
      </PageContainer>
    );
  // The shared connection only controls visibility/reset. The support endpoint
  // resolves the current person's identity; this profile may belong to a teammate.
  return (
    <LinkedInbox key={`${connected}:${cloudUser?.email ?? ""}`} connected={connected}>
      {children}
    </LinkedInbox>
  );
}

function LinkedInbox({ connected, children }: { connected: boolean; children: Inbox }) {
  const { t } = useI18n();
  const copy = t.support;
  const { cloudAuthUrl } = usePlatform();
  const [session, setSession] = useState<CloudSupportSession | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  const mounted = useRef(false);
  const generation = useRef(0);
  const accountKey = useRef<string | undefined>(undefined);
  accountKey.current = session?.account?.key;

  const load = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    try {
      const result = await getCloudSupportSession();
      if (!mounted.current || generation.current !== request) return;
      setSession(result);
      setFailed(false);
    } catch (error) {
      observeCaughtError(error, "dashboard/components/support/LinkedSupportCenter");
      if (!mounted.current || generation.current !== request) return;
      setFailed(true);
      if (
        (error instanceof ApiError && [401, 403].includes(error.status)) ||
        getApiErrorCode(error) === "SUPPORT_ACCOUNT_CHANGED"
      )
        setSession(null);
      // Keep an existing draft through a transient connection check failure.
    } finally {
      if (mounted.current && generation.current === request) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const key = session?.account?.key;
  const client = useMemo(
    () =>
      createCloudSupportApi(key, () => {
        if (!mounted.current || accountKey.current !== key) return;
        setSession(null);
        void load();
      }),
    [key, load],
  );

  if (session?.account) return children(session.account, client);
  if (checking)
    return (
      <PageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          {copy.checkingConnection}
        </p>
      </PageContainer>
    );
  return (
    <PageContainer>
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <section className="mt-6 max-w-xl rounded-2xl bg-card p-6 sm:p-8">
        <span className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon name="help-circle" className="size-6" aria-hidden="true" />
        </span>
        <h2 className="text-lg font-semibold">{copy.cloudTitle}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {connected ? copy.teamConnectionDescription : copy.connectDescription}
        </p>
        {failed && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {copy.connectionFailed}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <a href={`${cloudAuthUrl.replace(/\/$/, "")}/support`} target="_blank" rel="noreferrer">
              {copy.openCloud}
            </a>
          </Button>
          {failed ? (
            <Button variant="secondary" onClick={() => void load()}>
              {copy.retry}
            </Button>
          ) : (
            !connected && (
              <Button asChild variant="secondary">
                <Link href="/settings">{t.dashboard.nav.settings}</Link>
              </Button>
            )
          )}
        </div>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">{copy.privateHint}</p>
      </section>
    </PageContainer>
  );
}
