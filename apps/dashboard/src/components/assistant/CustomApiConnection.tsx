"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";

/** Shared by connection settings and automation setup. Keys are submitted once, never read back. */
export function CustomApiConnection({
  onSaved,
  available = true,
}: {
  onSaved(model: string): void;
  available?: boolean;
}) {
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "", model: "" });
  const action = useScopedMutation();
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await action.execute(() => assistantApi.customApi(form));
        if (result) {
          setForm({ name: "", baseUrl: "", apiKey: "", model: "" });
          onSaved(result.model);
        }
      }}
    >
      <div>
        <h3 className="text-base font-medium">Connect your API</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Use an API with Responses support and tool calling. Your key stays on your assistant host.
        </p>
      </div>
      {(
        [
          ["name", "Connection name", "e.g. Our AI gateway"],
          ["baseUrl", "API base URL", "https://api.example.com/v1"],
          ["model", "Model ID", "Your provider’s model or deployment ID"],
          ["apiKey", "API key", "Enter your API key"],
        ] as const
      ).map(([key, label, placeholder]) => (
        <label key={key} className="block space-y-2 text-sm">
          <span>{label}</span>
          <Input
            variant="filled"
            type={key === "apiKey" ? "password" : key === "baseUrl" ? "url" : "text"}
            autoComplete="off"
            required
            value={form[key]}
            placeholder={placeholder}
            maxLength={
              key === "apiKey" ? 8000 : key === "baseUrl" ? 1000 : key === "name" ? 80 : 128
            }
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            disabled={action.busy}
          />
        </label>
      ))}
      {!available && (
        <p className="text-sm text-warning">
          Update the assistant runtime on your host to connect a custom API.
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-danger">
          {action.error}
        </p>
      )}
      <Button
        type="submit"
        disabled={!available || action.busy || Object.values(form).some((v) => !v.trim())}
      >
        {action.busy ? "Saving connection…" : "Save connection"}
        <Icon name="arrow-right" />
      </Button>
    </form>
  );
}
