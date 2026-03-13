"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, ArrowRight } from "lucide-react";
import { encodeRepoSlug } from "@/utils/repoSlug";

export function UrlImport() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const match = url.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)/
    );
    if (!match) {
      setError("Enter a valid GitHub repository URL");
      return;
    }

    const [, owner, repo] = match;
    const slug = encodeRepoSlug(owner!, repo!);
    router.push(`/deploy/${slug}`);
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="p-8">
        <div className="max-w-lg mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-foreground/[0.06] flex items-center justify-center mx-auto mb-4">
            <Link2 className="size-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground text-center mb-1.5">
            Import from Git URL
          </h3>
          <p className="text-sm text-muted-foreground text-center mb-6 leading-relaxed">
            Paste a public repository URL to import. No GitHub connection required.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                placeholder="https://github.com/username/repository"
                className={`w-full px-4 py-3 bg-background border rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 transition-all ${
                  error
                    ? "border-red-500/50 focus:ring-red-500/20"
                    : "border-border/50 focus:ring-primary/20"
                }`}
              />
              {error && (
                <p className="text-xs text-red-500 mt-1.5">{error}</p>
              )}
            </div>
            <button
              type="submit"
              disabled={!url.trim()}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Import Repository
              <ArrowRight className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
