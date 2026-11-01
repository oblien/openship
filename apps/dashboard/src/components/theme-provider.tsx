"use client";
import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_TOKENS,
  appearanceTheme,
  defaultAppearance,
  parseAppearance,
  type AppearancePreferences,
  type ThemeMode,
} from "@repo/core";
import { useAuth } from "@/context/AuthContext";
import { settingsApi } from "@/lib/api/settings";
import { getApiBaseUrl, getApiErrorMessage } from "@/lib/api/client";
import {
  appearanceCacheKey,
  cachedAppearance,
  cacheAppearance,
  resolveAppearance,
  applyAppearance,
  bootAppearance,
  APPEARANCE_CACHE_POINTER,
} from "@/lib/appearance-runtime";

type Theme = ThemeMode | "system";
interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ThemeMode;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  preferences: AppearancePreferences;
  savedPreferences: AppearancePreferences;
  previewAppearance: (preferences: AppearancePreferences) => void;
  discardAppearance: () => void;
  saveAppearance: (preferences: AppearancePreferences) => Promise<void>;
  reloadAppearance: () => void;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  appearanceError: string | null;
  revision: number;
  owner: string;
}
const fallbackPreferences = defaultAppearance();
// Retain the existing light/no-op behavior for standalone shared components.
const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  toggle: () => {},
  preferences: fallbackPreferences,
  savedPreferences: fallbackPreferences,
  previewAppearance: () => {},
  discardAppearance: () => {},
  saveAppearance: async () => {
    throw new Error("ThemeProvider is required to save appearance");
  },
  reloadAppearance: () => {},
  ready: false,
  loading: false,
  saving: false,
  appearanceError: null,
  revision: 0,
  owner: "anonymous",
});
export function useTheme() {
  return useContext(ThemeContext);
}
const isDesktop = () => !!(window as { desktop?: { isDesktop?: boolean } }).desktop?.isDesktop;
function legacyAppearance() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    /* diagnostics-ignore: Browser storage may be disabled; retain the built-in preference. */
  }
  return defaultAppearance(
    ["light", "dim", "dark", "system"].includes(stored ?? "")
      ? stored!
      : isDesktop()
        ? "system"
        : "light",
  );
}
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const owner = `${getApiBaseUrl()}:${user?.id ?? "anonymous"}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [saved, setSaved] = useState<AppearancePreferences>(defaultAppearance());
  const [draft, setDraft] = useState<AppearancePreferences | null>(null);
  const [stateOwner, setStateOwner] = useState(owner);
  const [ready, setReady] = useState(false);
  const pendingSave = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveSequence = useRef(0);
  const loadSequence = useRef(0);
  const reloadAppearance = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    if (authLoading) return;
    let active = true;
    const sequence = ++loadSequence.current;
    ++saveSequence.current;
    pendingSave.current = false;
    setSaving(false);
    if (stateOwner !== owner) setDraft(null);
    setStateOwner(owner);
    setError(null);
    setReady(false);
    const local = user ? cachedAppearance(appearanceCacheKey(owner)) : null;
    const fallback = local ?? legacyAppearance();
    setSaved(fallback);
    setInitialized(true);
    if (!user) {
      try {
        localStorage.removeItem(APPEARANCE_CACHE_POINTER);
      } catch {
        /* diagnostics-ignore: An unavailable browser cache must not block sign-out. */
      }
      setLoading(false);
      setReady(true);
      return;
    }
    setLoading(true);
    void settingsApi
      .getAppearance()
      .then((result) => {
        if (!active || sequence !== loadSequence.current || ownerRef.current !== owner) return;
        const preferences =
          result.appearance === null ? legacyAppearance() : parseAppearance(result.appearance);
        setSaved(preferences);
        cacheAppearance(
          appearanceCacheKey(owner),
          preferences,
          resolveAppearance(
            preferences,
            isDesktop(),
            matchMedia("(prefers-color-scheme: dark)").matches,
          ),
        );
        setLoading(false);
        setReady(true);
      })
      .catch((cause) => {
        if (active && sequence === loadSequence.current && ownerRef.current === owner) {
          setError(getApiErrorMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [owner, user?.id, authLoading, reload]);
  const scopedSaved = stateOwner === owner ? saved : defaultAppearance();
  const preferences = stateOwner === owner ? (draft ?? saved) : scopedSaved;
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(query.matches);
    const changed = () => setSystemDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const resolvedTheme =
    typeof window === "undefined"
      ? "light"
      : resolveAppearance(preferences, isDesktop(), systemDark);
  useEffect(() => {
    if (!initialized || stateOwner !== owner) return;
    applyAppearance(preferences, resolvedTheme);
    setRevision((value) => value + 1);
    if (!draft && user) cacheAppearance(appearanceCacheKey(owner), saved, resolvedTheme);
  }, [preferences, resolvedTheme, initialized, stateOwner, owner, user?.id, draft, saved]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== appearanceCacheKey(owner) || draftRef.current) return;
      const next = cachedAppearance(event.key);
      if (next) setSaved(next);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [owner]);
  const saveAppearance = useCallback(
    async (next: AppearancePreferences) => {
      if (pendingSave.current) throw new Error("An appearance save is already in progress");
      if (!ready) throw new Error("Load your saved appearance before saving. Try again.");
      const validated = parseAppearance(next);
      pendingSave.current = true;
      const scope = ownerRef.current;
      const sequence = ++saveSequence.current;
      ++loadSequence.current;
      setSaving(true);
      setError(null);
      try {
        if (!user) throw new Error("Sign in to save appearance");
        await settingsApi.setAppearance(validated);
        if (scope !== ownerRef.current || sequence !== saveSequence.current) return;
        setSaved(validated);
        setDraft(null);
      } catch (cause) {
        if (scope === ownerRef.current && sequence === saveSequence.current)
          setError(getApiErrorMessage(cause));
        throw cause;
      } finally {
        if (scope === ownerRef.current && sequence === saveSequence.current) {
          setSaving(false);
          pendingSave.current = false;
        }
      }
    },
    [user?.id, ready],
  );
  const setTheme = useCallback(
    (theme: Theme) => {
      if (pendingSave.current) return;
      const next = { ...savedRef.current, active: theme };
      setDraft(next);
      try {
        localStorage.setItem("theme", theme);
      } catch {
        /* diagnostics-ignore: Browser caching is optional; account persistence still runs. */
      }
      if (user && ready)
        void saveAppearance(next).catch(() => {
          /* diagnostics-ignore: saveAppearance already reports and exposes the failure. */
        });
      else if (!user) {
        setSaved(next);
        setDraft(null);
      }
    },
    [saveAppearance, user?.id, ready],
  );
  const theme: Theme = ["light", "dim", "dark", "system"].includes(preferences.active)
    ? (preferences.active as Theme)
    : (appearanceTheme(preferences)?.base ?? "light");
  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolvedTheme,
        setTheme,
        toggle: () =>
          setTheme(resolvedTheme === "light" ? "dim" : resolvedTheme === "dim" ? "dark" : "light"),
        preferences,
        savedPreferences: scopedSaved,
        previewAppearance: (next) => setDraft(parseAppearance(next)),
        discardAppearance: () => setDraft(null),
        saveAppearance,
        reloadAppearance,
        ready,
        loading: loading || stateOwner !== owner,
        saving,
        appearanceError: error,
        revision,
        owner,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
/** Uses the same cached variables as the runtime painter, before styles/hydration arrive. */
export function ThemeScript() {
  const script = `(${bootAppearance.toString()})(${JSON.stringify(Object.fromEntries(Object.entries(APPEARANCE_DEFAULTS).map(([mode, values]) => [mode, { "--th-bg-page": values["--th-bg-page"] }])))},${JSON.stringify(APPEARANCE_TOKENS.map(({ key, type }) => ({ key, type })))});`;
  return (
    <script dangerouslySetInnerHTML={{ __html: script.replaceAll("</script", "<\\/script") }} />
  );
}
