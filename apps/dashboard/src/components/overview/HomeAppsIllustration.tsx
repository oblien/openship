"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppLogo } from "@/components/AppLogo";
import type { AppCatalogEntry } from "@/lib/api/apps";
import styles from "./HomeAppsIllustration.module.css";

const FEATURED_APPS = [
  "supabase",
  "pocketbase",
  "convex",
  "minio",
  "grafana",
  "neon",
  "qdrant",
  "gitea",
  "vaultwarden",
  "code-server",
  "posthog",
  "mail",
];

const TILES = [
  { position: "start-0 top-7 size-7 -rotate-12", logo: "size-4" },
  { position: "start-10 top-1 size-9 rotate-6", logo: "size-5" },
  { position: "start-24 top-3 size-11 -rotate-3", logo: "size-7" },
  { position: "end-10 top-0 size-8 rotate-12", logo: "size-5" },
  { position: "end-0 top-8 size-7 -rotate-6", logo: "size-4" },
];

export default function HomeAppsIllustration({
  suggestions,
  loading = false,
}: {
  suggestions?: readonly Pick<AppCatalogEntry, "id" | "name">[];
  loading?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const interactive = suggestions !== undefined;
  // The first render stays deterministic for SSR; later swaps happen only on screen.
  const [apps, setApps] = useState(() => FEATURED_APPS.slice(0, TILES.length));

  useEffect(() => {
    // Clickable recommendations stay in place so choosing a logo never changes its target.
    if (interactive) return;
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let previousSlot = -1;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      stop();
      if (!visible || document.hidden || motion.matches) return;
      timer = setInterval(() => {
        // One different slot per turn, with no duplicate logos in the composition.
        const slot =
          (previousSlot + 1 + Math.floor(Math.random() * (TILES.length - 1))) % TILES.length;
        const choice = Math.random();
        previousSlot = slot;
        setApps((current) => {
          const available = FEATURED_APPS.filter((app) => !current.includes(app));
          return current.map((app, index) =>
            index === slot ? available[Math.floor(choice * available.length)] : app,
          );
        });
      }, 5_000);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, [interactive]);

  if (interactive && !loading && suggestions.length === 0) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden={interactive ? undefined : true}
      aria-busy={loading || undefined}
      className="relative mx-auto mb-2 h-16 w-full max-w-56"
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full rtl:-scale-x-100"
        viewBox="0 0 224 64"
        fill="none"
      >
        <path
          d="M14 42L58 22L118 34L168 16L210 46"
          stroke="var(--th-on-12)"
          strokeWidth="1.5"
          strokeDasharray="3 4"
          strokeLinecap="round"
        />
        <circle cx="18" cy="12" r="2" fill="var(--th-on-10)" />
        <circle cx="84" cy="54" r="2" fill="var(--th-on-08)" />
        <circle cx="194" cy="8" r="2.5" fill="var(--th-on-10)" />
      </svg>
      {TILES.map((tile, index) => {
        const suggestion = suggestions?.[index];
        if (interactive && !suggestion && !loading) return null;
        const appId = suggestion?.id ?? apps[index];
        const tileClass = `absolute flex items-center justify-center rounded-xl bg-card shadow-sm ring-1 ring-border/60 ${tile.position}`;
        const logo = loading ? (
          <span className={`rounded-md bg-muted motion-safe:animate-pulse ${tile.logo}`} />
        ) : (
          <span
            key={appId}
            className={`flex items-center justify-center rounded-md ${tile.logo} ${styles.logo}`}
          >
            <AppLogo appId={appId} className="size-full" />
          </span>
        );
        return suggestion && !loading ? (
          <Link
            key={index}
            href={`/apps/new?app=${encodeURIComponent(suggestion.id)}`}
            aria-label={suggestion.name}
            title={suggestion.name}
            className={`${tileClass} motion-safe:transition-transform hover:z-10 motion-safe:hover:-translate-y-1 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {logo}
          </Link>
        ) : (
          <div key={index} aria-hidden="true" className={tileClass}>
            {logo}
          </div>
        );
      })}
    </div>
  );
}
