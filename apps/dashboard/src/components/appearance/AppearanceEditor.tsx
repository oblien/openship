"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_MAX_THEMES,
  APPEARANCE_TOKENS,
  AppearancePreferencesSchema,
  appearanceTheme,
  appearanceVariables,
  createTheme,
  validAppearanceToken,
  isThemeFontData,
  THEME_MODES,
  type AppearancePreferences,
  type ThemeDocument,
  type AppearanceTokenGroup,
  type ThemeMode,
} from "@repo/core";
import { useTheme } from "@/components/theme-provider";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { importAppearance, fetchAppearanceJson, downloadTheme } from "@/lib/appearance-import";
import { getApiErrorMessage } from "@/lib/api/client";

const PRESET_ICONS = { light: "sun", dim: "sun-moon", dark: "moon", system: "monitor" } as const;

export function AppearanceEditor() {
  const { owner } = useTheme();
  return <Editor key={owner} />;
}
function Editor() {
  const context = useTheme();
  const { t } = useI18n();
  const c = t.settings.appearance.editor;
  const common = t.settings.common;
  const [draft, setDraft] = useState(context.savedPreferences);
  const [group, setGroup] = useState<AppearanceTokenGroup>("surfaces");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(context.savedPreferences);
  const modified = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const custom = appearanceTheme(draft);
  const base: ThemeMode =
    custom?.base ??
    (THEME_MODES.includes(draft.active as ThemeMode)
      ? (draft.active as ThemeMode)
      : context.resolvedTheme);
  const lastValidTheme = useRef<ThemeDocument | undefined>(custom);
  const validation = useMemo(() => AppearancePreferencesSchema.safeParse(draft), [draft]);
  if (validation.success) lastValidTheme.current = appearanceTheme(validation.data);
  useEffect(() => {
    if (!modified.current) setDraft(context.savedPreferences);
  }, [context.savedPreferences]);
  useEffect(() => {
    if (dirty && validation.success) context.previewAppearance(validation.data);
    else if (!dirty) context.discardAppearance();
    // The provider's callback may change; the draft alone controls preview lifetime.
  }, [draft]);
  useEffect(() => () => context.discardAppearance(), []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  function update(next: AppearancePreferences) {
    modified.current = true;
    setDraft(next);
    setSavedNotice(false);
    setNotice(null);
  }
  function edit(mutate: (theme: ThemeDocument) => ThemeDocument) {
    if (
      !appearanceTheme(draftRef.current) &&
      draftRef.current.themes.length >= APPEARANCE_MAX_THEMES
    ) {
      setNotice(c.libraryLimit);
      return;
    }
    const selected =
      appearanceTheme(draftRef.current) ??
      createTheme(base, `theme-${crypto.randomUUID()}`, c.newTheme);
    const next = mutate(selected);
    update({
      ...draftRef.current,
      active: next.id,
      themes: [...draftRef.current.themes.filter((theme) => theme.id !== next.id), next],
    });
  }
  function duplicate() {
    if (draft.themes.length >= APPEARANCE_MAX_THEMES) return;
    const next = {
      ...(custom ?? createTheme(base, "temporary", c.newTheme)),
      id: `theme-${crypto.randomUUID()}`,
      name: custom ? `${custom.name.slice(0, 48)} · ${c.duplicate}`.slice(0, 64) : c.newTheme,
    };
    update({ ...draft, active: next.id, themes: [...draft.themes, next] });
  }
  async function save() {
    if (!validation.success) return;
    try {
      await context.saveAppearance(validation.data);
      modified.current = false;
      setDraft(validation.data);
      setSavedNotice(true);
    } catch {
      /* diagnostics-ignore: The shared provider reports the save failure and retains the draft. */
    }
  }
  async function uploadFont(role: "sans" | "mono", file?: File) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error(c.fontHint);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "wOF2") throw new Error(c.fontHint);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = btoa(binary);
      if (!isThemeFontData(data)) throw new Error(c.fontHint);
      const face = new FontFace("OpenshipUploadPreview", bytes.buffer);
      await face.load();
      edit((theme) => ({
        ...theme,
        typography: { ...theme.typography, [role]: "custom" },
        fonts: [
          ...theme.fonts.filter((font) => font.role !== role),
          { role, name: file.name.slice(0, 80), data },
        ],
      }));
    } catch (cause) {
      setNotice(getApiErrorMessage(cause));
    }
  }
  const shown = APPEARANCE_TOKENS.filter((token) =>
    search ? token.key.includes(search.toLowerCase()) : token.group === group,
  );
  const invalid = !validation.success;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium text-foreground">{t.settings.appearance.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => setImporting(true)}
            disabled={context.saving || context.loading}
          >
            <Icon name="upload" />
            {common.toast.import}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              downloadTheme(
                custom ??
                  createTheme(
                    base,
                    `theme-${crypto.randomUUID()}`,
                    t.settings.appearance.themes[base],
                  ),
                "openship-theme.json",
              )
            }
          >
            <Icon name="download" />
            {c.export}
          </Button>
        </div>
      </div>
      {context.appearanceError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-danger-bg p-4 text-sm text-danger"
        >
          <span>{context.appearanceError}</span>
          <Button variant="outline" size="sm" onClick={context.reloadAppearance}>
            {c.retry}
          </Button>
        </div>
      )}
      {notice && (
        <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger">
          {notice}
        </p>
      )}
      <fieldset
        disabled={context.loading || context.saving}
        className="min-w-0 space-y-5 disabled:opacity-60"
      >
        <section className="rounded-2xl bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={c.presets}
              className="grid w-full grid-cols-2 gap-1 rounded-xl bg-background/60 p-1 sm:flex sm:w-auto sm:flex-wrap"
            >
              {(["light", "dim", "dark", "system"] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={draft.active === mode}
                  onClick={() => update({ ...draft, active: mode })}
                  className={`h-9 px-3 ${draft.active === mode ? "bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.08]" : "text-muted-foreground"}`}
                >
                  <Icon name={PRESET_ICONS[mode]} className="size-4 shrink-0" />
                  {t.settings.appearance.themes[mode]}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto"
              disabled={draft.themes.length >= APPEARANCE_MAX_THEMES}
              title={draft.themes.length >= APPEARANCE_MAX_THEMES ? c.libraryLimit : undefined}
              onClick={duplicate}
            >
              <Icon name="plus" />
              {custom ? c.duplicate : c.newTheme}
            </Button>
          </div>
          {draft.themes.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {draft.themes.map((theme) => (
                <button
                  type="button"
                  key={theme.id}
                  aria-pressed={draft.active === theme.id}
                  onClick={() => update({ ...draft, active: theme.id })}
                  className={`flex max-w-full items-center gap-2 rounded-xl px-3 py-2 text-sm ${draft.active === theme.id ? "bg-foreground/[0.08]" : "bg-background"}`}
                >
                  <span
                    className="size-3 shrink-0 rounded-full border border-border"
                    style={{
                      background:
                        theme.tokens["--th-bg-page"] ??
                        APPEARANCE_DEFAULTS[theme.base]["--th-bg-page"],
                    }}
                  />
                  <span className="truncate">{theme.name}</span>
                  {draft.active === theme.id && <Icon name="check" className="size-3.5" />}
                </button>
              ))}
            </div>
          )}
        </section>
        <div className="grid min-w-0 gap-5 min-[1500px]:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-5">
            <section className="space-y-4 rounded-2xl bg-card p-5">
              {custom && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={c.name}>
                    <Input
                      variant="filled"
                      value={custom.name}
                      maxLength={64}
                      aria-invalid={!custom.name.trim()}
                      onChange={(event) =>
                        edit((theme) => ({ ...theme, name: event.target.value }))
                      }
                    />
                  </Field>
                  <Field label={c.base}>
                    <CustomSelect
                      variant="filled"
                      value={base}
                      options={THEME_MODES.map((value) => ({
                        value,
                        label: t.settings.appearance.themes[value],
                      }))}
                      onChange={(value) => edit((theme) => ({ ...theme, base: value }))}
                    />
                  </Field>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{c.tokens}</h3>
                {custom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => edit((theme) => ({ ...theme, tokens: {} }))}
                  >
                    {c.reset}
                  </Button>
                )}
              </div>
              <Input
                variant="filled"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={c.search}
                aria-label={c.search}
              />
              <div className="flex flex-wrap gap-1.5">
                {(["surfaces", "text", "controls", "status", "effects", "scales"] as const).map(
                  (value) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => {
                        setGroup(value);
                        setSearch("");
                      }}
                      aria-pressed={group === value && !search}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${group === value && !search ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      {c.groups[value]}
                    </button>
                  ),
                )}
              </div>
              <div className="max-h-[540px] space-y-3 overflow-y-auto pe-1">
                {shown.map((token) => {
                  const overridden = Object.hasOwn(custom?.tokens ?? {}, token.key);
                  const value = custom?.tokens[token.key] ?? APPEARANCE_DEFAULTS[base][token.key];
                  const bad =
                    overridden &&
                    (!validAppearanceToken(token.key, value) ||
                      (!validation.success &&
                        validation.error.issues.some((issue) => issue.path.includes(token.key))));
                  const inputId = `appearance-${token.key}`;
                  return (
                    <div key={token.key} className="space-y-1">
                      <label
                        htmlFor={inputId}
                        className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span dir="ltr" className="truncate font-mono" title={token.key}>
                          {token.key}
                        </span>
                        {overridden && (
                          <button
                            type="button"
                            className="shrink-0 text-foreground underline-offset-2 hover:underline"
                            onClick={() =>
                              edit((theme) => {
                                const tokens = { ...theme.tokens };
                                delete tokens[token.key];
                                return { ...theme, tokens };
                              })
                            }
                          >
                            {c.reset}
                          </button>
                        )}
                      </label>
                      <div className="flex items-center gap-2">
                        {token.type === "color" && (
                          <label
                            className="relative size-9 shrink-0 overflow-hidden rounded-lg border border-border"
                            style={{ background: bad ? "transparent" : value }}
                          >
                            <input
                              type="color"
                              aria-label={`${token.key} ${c.color}`}
                              className="absolute inset-0 cursor-pointer opacity-0"
                              value={/^#[\da-f]{6}$/i.test(value) ? value : "#808080"}
                              onChange={(event) =>
                                edit((theme) => ({
                                  ...theme,
                                  tokens: { ...theme.tokens, [token.key]: event.target.value },
                                }))
                              }
                            />
                          </label>
                        )}
                        <Input
                          id={inputId}
                          dir="ltr"
                          variant="filled"
                          className="font-mono text-xs"
                          value={value}
                          aria-invalid={bad}
                          aria-describedby={bad ? `${inputId}-error` : undefined}
                          onChange={(event) =>
                            edit((theme) => ({
                              ...theme,
                              tokens: { ...theme.tokens, [token.key]: event.target.value },
                            }))
                          }
                        />
                      </div>
                      {bad && (
                        <p id={`${inputId}-error`} className="text-xs text-danger">
                          {c.invalid}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="space-y-4 rounded-2xl bg-card p-5">
              <h3 className="font-medium">{c.typography}</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {(["sans", "mono"] as const).map((role) => (
                  <div key={role} className="space-y-2">
                    <Field label={role === "sans" ? c.interfaceFont : c.monoFont}>
                      <CustomSelect
                        variant="filled"
                        value={custom?.typography[role] ?? (role === "sans" ? "gellix" : "mono")}
                        options={(role === "sans"
                          ? ["gellix", "system", "serif"]
                          : ["mono", "systemMono"]
                        )
                          .concat(
                            custom?.fonts.some((font) => font.role === role) ? ["custom"] : [],
                          )
                          .map((value) => ({
                            value,
                            label:
                              value === "custom"
                                ? custom!.fonts.find((font) => font.role === role)!.name
                                : (
                                    {
                                      gellix: "Gellix",
                                      system: c.systemFont,
                                      serif: c.serifFont,
                                      mono: "JetBrains Mono",
                                      systemMono: c.systemMono,
                                    } as Record<string, string>
                                  )[value],
                          }))}
                        onChange={(value) =>
                          edit((theme) => ({
                            ...theme,
                            typography: {
                              ...theme.typography,
                              [role]: value,
                            } as ThemeDocument["typography"],
                          }))
                        }
                      />
                    </Field>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <Icon name="upload" className="size-3.5" />
                      {c.uploadFont}
                      <input
                        type="file"
                        accept=".woff2,font/woff2"
                        className="sr-only"
                        aria-label={`${role === "sans" ? c.interfaceFont : c.monoFont}: ${c.uploadFont}`}
                        onChange={(event) => {
                          void uploadFont(role, event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                ))}
                {(
                  [
                    ["size", c.fontSize, 12, 20, 1],
                    ["monoSize", c.monoSize, 10, 20, 1],
                    ["lineHeight", c.lineHeight, 1.3, 2, 0.05],
                    ["weight", c.weight, 300, 700, 100],
                  ] as const
                ).map(([key, label, min, max, step]) => (
                  <Field key={key} label={label}>
                    <Input
                      variant="filled"
                      type="number"
                      min={min}
                      max={max}
                      step={step}
                      aria-invalid={
                        custom
                          ? custom.typography[key] < min || custom.typography[key] > max
                          : false
                      }
                      value={
                        custom?.typography[key] ??
                        createTheme(base, "temporary", "temporary").typography[key]
                      }
                      onChange={(event) =>
                        edit((theme) => ({
                          ...theme,
                          typography: { ...theme.typography, [key]: Number(event.target.value) },
                        }))
                      }
                    />
                  </Field>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{c.fontHint}</p>
            </section>
            {custom && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() =>
                    update({
                      ...draft,
                      themes: draft.themes.filter((theme) => theme.id !== custom.id),
                      active: custom.base,
                    })
                  }
                >
                  {common.remove}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => downloadTheme(draft, "openship-appearance.json")}
                >
                  {c.exportAll}
                </Button>
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="sticky top-5 space-y-3">
              <p className="text-sm font-medium text-muted-foreground">{c.preview}</p>
              <ThemePreview
                theme={lastValidTheme.current}
                base={lastValidTheme.current?.base ?? base}
              />
              <p className="text-xs text-muted-foreground">{c.personal}</p>
            </div>
          </div>
        </div>
      </fieldset>
      <div
        data-appearance-preview
        data-theme={base}
        style={
          {
            ...APPEARANCE_DEFAULTS[base],
            "--font-sans": "system-ui, sans-serif",
            fontFamily: "system-ui, sans-serif",
            fontWeight: 400,
            lineHeight: 1.5,
          } as CSSProperties & Record<string, string | number>
        }
        className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-popover/90 p-4 shadow-lg backdrop-blur-xl"
      >
        <p role="status" className={`text-sm ${invalid ? "text-danger" : "text-muted-foreground"}`}>
          {context.loading
            ? common.loading
            : invalid
              ? c.invalid
              : context.saving
                ? common.loading
                : dirty
                  ? c.unsaved
                  : c.saved}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={context.saving || context.loading}
            onClick={() => update({ version: 1, active: "light", themes: [] })}
          >
            {c.reset}
          </Button>
          <Button
            variant="ghost"
            disabled={context.saving || !dirty}
            onClick={() => {
              modified.current = false;
              setDraft(context.savedPreferences);
              context.discardAppearance();
              setNotice(null);
            }}
          >
            {c.discard}
          </Button>
          <Button
            disabled={!dirty || invalid || !context.ready || context.loading || context.saving}
            onClick={() => void save()}
          >
            {savedNotice ? <Icon name="check" /> : <Icon name="check-circle" />}
            {common.save}
          </Button>
        </div>
      </div>
      {importing && (
        <ImportDialog
          current={draft}
          onClose={() => setImporting(false)}
          onImport={(next) => {
            update(next);
            setImporting(false);
          }}
        />
      )}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-2 text-sm text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}
function ThemePreview({ theme, base }: { theme?: ThemeDocument; base: ThemeMode }) {
  const { t } = useI18n();
  const c = t.settings.appearance.editor;
  return (
    <div
      data-appearance-preview
      data-theme={base}
      style={
        {
          ...APPEARANCE_DEFAULTS[base],
          ...appearanceVariables(theme),
          fontFamily: "var(--font-sans)",
          fontSize: `${theme?.typography.size ?? 16}px`,
          lineHeight: theme?.typography.lineHeight ?? 1.5,
        } as CSSProperties & Record<string, string | number>
      }
      className="space-y-4 rounded-2xl bg-background p-5 text-foreground ring-1 ring-border/50"
    >
      <div className="flex items-center gap-2">
        <Icon name="grid" className="size-4" />
        <span className="font-medium">{c.workspace}</span>
      </div>
      <div className="space-y-3 rounded-xl bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-success-solid" />
          <span className="text-sm font-medium">openship</span>
        </div>
        <p className="text-sm text-muted-foreground">{c.personal}</p>
        <div className="flex flex-wrap gap-1.5">
          {[
            [c.active, "bg-success-bg text-success"],
            [c.queued, "bg-warning-bg text-warning"],
            [c.failed, "bg-danger-bg text-danger"],
          ].map(([text, color]) => (
            <span key={text} className={`rounded-md px-2 py-1 text-xs ${color}`}>
              {text}
            </span>
          ))}
        </div>
      </div>
      <Input variant="filled" readOnly aria-label={c.preview} value="app.example.com" />
      <Button className="w-full" type="button">
        {t.settings.common.create}
      </Button>
      <div className="rounded-xl bg-card p-3 font-mono text-xs text-muted-foreground">
        <span className="text-success">✓</span> build completed
        <br />
        <span className="text-info">→</span> ready to deploy
      </div>
      <div className="flex h-12 items-end gap-2" aria-hidden="true">
        {[40, 65, 48, 80, 60, 100, 76].map((height, index) => (
          <span
            key={index}
            className="flex-1 rounded-t bg-info-solid/70"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    </div>
  );
}
function ImportDialog({
  current,
  onImport,
  onClose,
}: {
  current: AppearancePreferences;
  onImport: (value: AppearancePreferences) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const c = t.settings.appearance.editor;
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      pending.current?.abort();
    },
    [],
  );
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  function accept(value: string) {
    try {
      onImport(importAppearance(value, current));
    } catch {
      /* diagnostics-ignore: Expected JSON/theme validation is shown inline without logging imported data. */ setError(
        c.invalid,
      );
    }
  }
  async function load() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const json = await fetchAppearanceJson(
        url,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (alive.current && !controller.signal.aborted) {
        setText(json);
      }
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(getApiErrorMessage(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      width="min(600px, 100%)"
      surface="frosted"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.settings.common.toast.import}
        ref={dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-4 p-5 outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">{t.settings.common.toast.import}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.settings.common.close}
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{c.importHint}</p>
        <Field label={c.url}>
          <div className="flex gap-2">
            <Input
              variant="filled"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/theme.json"
            />
            <Button variant="secondary" disabled={busy || !url} onClick={() => void load()}>
              {busy ? t.settings.common.loading : c.loadUrl}
            </Button>
          </div>
        </Field>
        <Field label={c.json}>
          <textarea
            dir="ltr"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            className="min-h-52 w-full rounded-xl bg-background p-3 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </Field>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Icon name="upload" className="size-4" />
          {c.selectFile}
          <input
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label={c.selectFile}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 1024 * 1024) {
                setError(c.invalid);
                return;
              }
              void file.text().then(
                (value) => {
                  if (alive.current) {
                    setText(value);
                    setError(null);
                  }
                },
                () => {
                  /* diagnostics-ignore: File-read failures are shown inline without logging uploaded data. */ if (
                    alive.current
                  )
                    setError(c.invalid);
                },
              );
            }}
          />
        </label>
        {error && (
          <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t.settings.common.cancel}
          </Button>
          <Button disabled={!text || busy} onClick={() => accept(text)}>
            {t.settings.common.toast.import}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
