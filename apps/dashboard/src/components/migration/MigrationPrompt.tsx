"use client";

import { useState } from "react";
import { PromptDetails } from "@/components/import-project/PromptDetails";
import { dockerMigrationApi, getApiErrorMessage, type MigrationRun } from "@/lib/api";

export function MigrationPrompt({ run }: { run: MigrationRun }) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prompt = run.pendingPrompt;
  if (!prompt) return null;
  const respond = async (action: string) => {
    setSubmitted(prompt.promptId);
    setError(null);
    try {
      await dockerMigrationApi.respond(run.id, prompt.promptId, action);
    } catch (err) {
      setSubmitted(null);
      setError(getApiErrorMessage(err));
    }
  };
  return (
    <div
      role="region"
      aria-label={prompt.title}
      className="space-y-3 rounded-xl border border-warning/30 bg-warning/5 p-4"
    >
      <p className="font-medium">{prompt.title}</p>
      <p className="text-sm text-muted-foreground">{prompt.message}</p>
      <PromptDetails details={prompt.details} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {prompt.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={submitted === prompt.promptId}
            onClick={() => void respond(action.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${
              action.variant === "danger"
                ? "bg-destructive text-destructive-foreground"
                : action.variant === "primary"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
