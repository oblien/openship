"use client";

/**
 * "Which mail server is the rail talking about?" — mounted only in Openship Mail
 * view, so a platform-mode dashboard never pays for the fetch.
 *
 * The URL wins: /emails already treats `?serverId=` as the single source of truth
 * for "which server am I acting on", and the rail has to agree with it or the two
 * would scope to different servers on the same screen. When there's no hint (the
 * operator is on /settings, say) it falls back the same way the page does: the
 * only installed server, else the first row.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { mailApi } from "@/lib/api";
import { pickActiveMailServer } from "@/lib/mail-active-server";
import { getMailScopeRevision, subscribeMailScope } from "@/lib/mail-scope-bus";

export interface MailScopeServer {
  id: string;
  name: string;
  host: string;
  domain: string | null;
  completed: boolean;
  active: boolean;
}

interface MailScopeValue {
  /** False until the first fetch settles — the rail shows a single generic entry
   *  until then rather than guessing at ten. */
  loaded: boolean;
  servers: MailScopeServer[];
  activeServerId: string | null;
  activeServer: MailScopeServer | null;
  refresh: () => void;
}

const EMPTY: MailScopeValue = {
  loaded: false,
  servers: [],
  activeServerId: null,
  activeServer: null,
  refresh: () => {},
};

const MailScopeContext = createContext<MailScopeValue>(EMPTY);

/** Safe outside the provider: platform view never mounts it, and the rail there
 *  doesn't read mail state. Returns the unloaded shape rather than throwing. */
export function useMailScope() {
  return useContext(MailScopeContext);
}

export function MailScopeProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const hintedServerId = searchParams.get("serverId");
  const [servers, setServers] = useState<MailScopeServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(getMailScopeRevision);

  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  // Refetch on the /emails page's signal (install finished, server adopted or
  // forgotten) so the rail expands from "Set up mail" to the ten tabs in place.
  useEffect(() => subscribeMailScope(() => setRevision(getMailScopeRevision())), []);

  useEffect(() => {
    let cancelled = false;
    mailApi
      .listMailServers()
      .then(({ servers: rows }) => {
        if (cancelled) return;
        setServers(rows);
      })
      .catch(() => {
        // Leave the list empty and mark loaded: the rail then offers "Set up
        // mail", which is a working link even if the reason we're here is a
        // transient API failure. Trapping the rail in its loading shape would be
        // worse — the operator couldn't navigate at all.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const value = useMemo<MailScopeValue>(() => {
    // Shared with /emails/webmail, which resolves the same server without this
    // provider mounted (platform view, or a direct link with no ?serverId=).
    const active = pickActiveMailServer(servers, hintedServerId);

    return {
      loaded,
      servers,
      activeServerId: active?.id ?? null,
      activeServer: active,
      refresh,
    };
  }, [servers, hintedServerId, loaded, refresh]);

  return <MailScopeContext.Provider value={value}>{children}</MailScopeContext.Provider>;
}
