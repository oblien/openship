"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionJobView } from "@repo/contracts";
import { actionsApi } from "@/lib/api/actions";
import { getApiErrorMessage } from "@/lib/api/client";
import { useActionScope } from "./useActions";
import type { JobEvent } from "./job-progress";

interface LogPage {
  events: JobEvent[];
  next: number;
  complete: boolean;
  loading: boolean;
  error: string | null;
}
const EMPTY: LogPage = { events: [], next: 0, complete: false, loading: true, error: null };
const CACHE_SIZE = 3;

/** One active journal serves the job list, topology and console. Retain a small
 * page-local cache so switching views/jobs cannot mix streams or lose a cursor. */
export function useActionLogEvents(job: ActionJobView | undefined) {
  const scope = useActionScope();
  const keyFor = (id: string) => `${scope}:${id}`;
  const key = job ? keyFor(job.id) : "";
  const jobId = job?.id;
  const liveGitHub = !!job?.externalUrl && !job.finishedAt;
  const cache = useRef(new Map<string, LogPage>());
  const [state, setState] = useState<{ key: string; page: LogPage }>({ key: "", page: EMPTY });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!jobId || liveGitHub) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let page = cache.current.get(key) ?? EMPTY;
    const publish = (next: LogPage) => {
      page = next;
      cache.current.delete(key);
      cache.current.set(key, page);
      while (cache.current.size > CACHE_SIZE)
        cache.current.delete(cache.current.keys().next().value!);
      setState({ key, page });
    };
    if (page.complete) {
      publish(page);
      return;
    }
    const poll = async () => {
      let delay = 2000;
      try {
        const response = await actionsApi.events(jobId, page.next);
        if (!active) return;
        const next = Math.max(page.next, response.next);
        publish({
          events: [
            ...page.events,
            ...response.events.filter((event) => event.sequence > page.next),
          ],
          next,
          complete: response.complete,
          loading: false,
          error: null,
        });
        if (response.complete) return;
        // Drain a saved backlog without waiting between each page.
        if (response.events.length >= 200) delay = 50;
      } catch (error) {
        if (active) publish({ ...page, loading: false, error: getApiErrorMessage(error) });
        delay = 5000;
      }
      if (active) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, jobId, liveGitHub, revision]);

  const page = state.key === key ? state.page : (cache.current.get(key) ?? EMPTY);
  return {
    ...page,
    liveGitHub,
    refresh,
    eventsFor: (id: string) => cache.current.get(keyFor(id))?.events ?? EMPTY.events,
  };
}
