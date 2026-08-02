"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, ArrowRight } from "lucide-react";
import { encodeRepoSlug, extractOwnerRepoFromUrl } from "@/utils/repoSlug";
import { useI18n } from "@/components/i18n-provider";

export function UrlImport() {
  const { t } = useI18n();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const parsed = extractOwnerRepoFromUrl(url.trim());
    if (!parsed) {
      setError(t.library.urlImport.invalidUrl);
      return;
    }

    const { owner, repo, provider } = parsed;
    const slug = encodeRepoSlug(owner, repo);
    // Tag GitLab imports so the deploy wizard resolves the repo through the
    // GitLab source instead of defaulting to GitHub.
    router.push(provider === "gitlab" ? `/deploy/${slug}?provider=gitlab` : `/deploy/${slug}`);
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="p-8">
        <div className="max-w-lg mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
            <Link2 className="size-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground text-center mb-1.5">
            {t.library.urlImport.title}
          </h3>
          <p className="text-sm text-muted-foreground text-center mb-6 leading-relaxed">
            {t.library.urlImport.description}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                placeholder="https://github.com/username/repository or https://gitlab.com/group/project"
                className={`w-full px-4 py-3 bg-background border rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-all ${
                  error
                    ? "border-danger-border focus:ring-danger-border"
                    : "border-border/50 focus:ring-primary/20"
                }`}
              />
              {error && (
                <p className="text-xs text-danger mt-1.5">{error}</p>
              )}
            </div>
            <button
              type="submit"
              disabled={!url.trim()}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t.library.urlImport.importButton}
              <ArrowRight className="size-4 rtl:rotate-180" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
