"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { frameworks } from "@/components/import-project/Frameworks";
import { encodeRepoSlug } from "@/utils/repoSlug";

export function TemplateGrid() {
  const router = useRouter();

  const handleSelect = (fw: { id: string; name: string }) => {
    const slug = encodeRepoSlug("openship", `template-${fw.id}`);
    router.push(`/deploy/${slug}?template=${fw.id}`);
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {frameworks
          .filter((fw) => fw.id !== "static")
          .map((fw) => (
            <button
              key={fw.id}
              onClick={() => handleSelect(fw)}
              className="flex flex-col items-center gap-3 p-5 rounded-xl border border-border/50 bg-background hover:bg-muted/40 hover:border-border transition-all group"
            >
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center group-hover:scale-105 transition-transform">
                {fw.icon("hsl(var(--foreground))")}
              </div>
              <span className="text-sm font-medium text-foreground">{fw.name}</span>
            </button>
          ))}
      </div>
    </div>
  );
}
