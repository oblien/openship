"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { encodeRepoSlug } from "@/utils/repoSlug";
import { useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function UrlImport({ header }: { header?: React.ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const parsed = new URL(url.trim());
      const parts = parsed.pathname.replace(/\/+$/, "").slice(1).split("/");
      const [owner, rawRepo] = parts;
      const repo = rawRepo?.replace(/\.git$/, "");
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        !["github.com", "www.github.com"].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.port ||
        parts.length !== 2 || !owner || !repo ||
        !/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)
      ) throw new Error("Invalid repository URL");
      router.push(`/deploy/${encodeRepoSlug(owner, repo)}`);
    } catch {
      setError(t.library.urlImport.invalidUrl);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      {header}
      <div className="p-8">
        <div className="max-w-lg mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
            <UiIcon name="link" className="size-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground text-center mb-1.5">
            {t.library.urlImport.title}
          </h3>
          <p className="text-sm text-muted-foreground text-center mb-6 leading-relaxed">
            {t.library.urlImport.description}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                type="url"
                variant="filled"
                autoFocus
                aria-label={t.library.urlImport.title}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                placeholder="https://github.com/username/repository"
                className={error ? "ring-2 ring-danger-border" : undefined}
              />
              {error && (
                <p id={errorId} role="alert" className="text-xs text-danger mt-1.5">{error}</p>
              )}
            </div>
            <Button
              type="submit"
              disabled={!url.trim()}
              className="w-full h-11"
            >
              {t.library.urlImport.importButton}
              <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
