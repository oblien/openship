"use client";
import { useId, useState } from "react";
import {
  pendingAssistantQuestions,
  type AssistantSnapshot,
  type QuestionAnswer,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { assistantApi } from "@/lib/api/assistant";
import { useScopedMutation } from "@/hooks/use-scoped-resource";

export function AssistantQuestions({
  snapshot,
  active,
  onAnswered,
}: {
  snapshot: AssistantSnapshot;
  active: boolean;
  onAnswered(): void;
}) {
  const requests = pendingAssistantQuestions(snapshot.messages, snapshot.activity.runId, active);
  const [opened, setOpened] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, QuestionAnswer>>>({});
  const [requestIds, setRequestIds] = useState<Record<string, string>>({});
  const panelId = useId();
  const action = useScopedMutation();
  const request = requests.find((r) => r.key === selected) ?? requests[0];
  if (!request) return null;
  const answers = drafts[request.key] ?? {},
    interaction = request.interaction;
  const ready = interaction.questions?.every(
    (q) => q.optional || answers[q.id]?.options?.length || answers[q.id]?.text?.trim(),
  );
  return (
    <section
      className="mb-3 overflow-hidden rounded-2xl bg-card/80 backdrop-blur-xl"
      aria-label="Agent questions"
      data-assistant-questions-open={opened}
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start gap-3 rounded-2xl px-4 py-3 text-start text-foreground"
        aria-label={opened ? "Hide agent questions" : "Show agent questions"}
        aria-expanded={opened}
        aria-controls={panelId}
        disabled={action.busy}
        onClick={() => setOpened((value) => !value)}
      >
        <Icon name="help-circle" className="text-muted-foreground" />
        <span role="status" className="min-w-0 flex-1 whitespace-normal text-sm font-normal">
          {requests.length === 1
            ? "Waiting for your answer"
            : `${requests.length} requests need your answer`}
        </span>
        <span className="text-xs text-muted-foreground">{opened ? "Hide" : "Answer"}</span>
        <Icon name={opened ? "chevron-down" : "chevron-up"} className="text-muted-foreground" />
      </Button>
      <form
        id={panelId}
        hidden={!opened}
        aria-label="Answer agent questions"
        aria-busy={action.busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || action.busy) return;
          void action.execute(async () => {
            const requestId = requestIds[request.key] ?? crypto.randomUUID();
            setRequestIds((previous) => ({ ...previous, [request.key]: requestId }));
            await assistantApi.respond(snapshot.conversation.id, {
              interactionId: interaction.id,
              requestId,
              answers,
            });
            onAnswered();
            setOpened(false);
          });
        }}
      >
        <div className="max-h-[min(40dvh,24rem)] space-y-4 overflow-y-auto overscroll-contain px-4 pt-1 pb-2">
          {requests.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {requests.map((r, i) => (
                <Button
                  key={r.key}
                  type="button"
                  variant={r === request ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={r === request}
                  disabled={action.busy}
                  onClick={() => {
                    setSelected(r.key);
                    action.setError(null);
                  }}
                >
                  Question {i + 1}
                </Button>
              ))}
            </div>
          )}
          <h2 className="text-sm font-medium">{interaction.title || "A question for you"}</h2>
          {interaction.questions?.map((question) => {
            const value = answers[question.id] ?? {};
            const update = (value: QuestionAnswer) => {
              setDrafts((previous) => ({
                ...previous,
                [request.key]: { ...previous[request.key], [question.id]: value },
              }));
              setRequestIds((previous) => {
                const next = { ...previous };
                delete next[request.key];
                return next;
              });
            };
            return (
              <fieldset key={question.id} disabled={action.busy} className="space-y-3">
                <legend
                  className={
                    interaction.questions?.length === 1 && interaction.title === question.title
                      ? "sr-only"
                      : "mb-3 text-sm font-medium"
                  }
                >
                  {question.title}
                  {question.optional ? " (optional)" : ""}
                </legend>
                {question.options?.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-start gap-3 rounded-xl bg-background/60 p-3"
                  >
                    <Checkbox
                      aria-label={option.label}
                      checked={value.options?.includes(option.id) ?? false}
                      onCheckedChange={(on) =>
                        update({
                          ...value,
                          options: on
                            ? question.multiSelect
                              ? [...(value.options ?? []), option.id]
                              : [option.id]
                            : (value.options ?? []).filter((id) => id !== option.id),
                        })
                      }
                    />
                    <span className="text-sm">
                      {option.label}
                      {option.description && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {(!question.options?.length || question.allowOther !== false) && (
                  <Input
                    variant="filled"
                    type={question.isSecret ? "password" : "text"}
                    aria-label={`Answer: ${question.title}`}
                    value={value.text ?? ""}
                    onChange={(event) => update({ ...value, text: event.target.value })}
                    placeholder="Your answer or more context"
                    maxLength={8000}
                  />
                )}
              </fieldset>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 p-4 pt-3">
          {action.error && (
            <p role="alert" className="min-w-0 flex-1 text-sm text-danger">
              {action.error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={!ready || action.busy}>
            {action.busy ? "Sending…" : "Send answer"}
          </Button>
        </div>
      </form>
    </section>
  );
}
