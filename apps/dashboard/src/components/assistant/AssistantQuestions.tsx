"use client";
import { useState } from "react";
import {
  pendingAssistantQuestions,
  type AssistantSnapshot,
  type QuestionAnswer,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { AssistantDialog } from "./AssistantDialog";
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
  const action = useScopedMutation();
  const request = requests.find((r) => r.key === selected) ?? requests[0];
  if (!request) return null;
  const answers = drafts[request.key] ?? {},
    interaction = request.interaction;
  const ready = interaction.questions?.every(
    (q) => q.optional || answers[q.id]?.options?.length || answers[q.id]?.text?.trim(),
  );
  return (
    <>
      <div className="mb-3 flex items-center gap-3 rounded-xl bg-card px-4 py-3">
        <Icon name="help-circle" className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm">
          {requests.length === 1
            ? "Your agent has a question"
            : `${requests.length} questions need your input`}
        </span>
        <Button size="sm" variant="secondary" onClick={() => setOpened(true)}>
          Answer
        </Button>
      </div>
      <AssistantDialog
        label="Agent question"
        isOpen={opened}
        closable={!action.busy}
        onClose={() => setOpened(false)}
        width="620px"
        maxWidth="94vw"
        footer={
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="ghost" disabled={action.busy} onClick={() => setOpened(false)}>
              Later
            </Button>
            <Button
              disabled={!ready || action.busy}
              onClick={() =>
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
                })
              }
            >
              {action.busy ? "Sending…" : "Send answer"}
            </Button>
          </div>
        }
      >
        <div className="space-y-5 p-6">
          <h2 className="text-lg font-medium">{interaction.title || "A question for you"}</h2>
          {requests.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {requests.map((r, i) => (
                <Button
                  key={r.key}
                  variant={r === request ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setSelected(r.key)}
                >
                  Question {i + 1}
                </Button>
              ))}
            </div>
          )}
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
                    className="flex cursor-pointer items-start gap-3 rounded-xl bg-card p-3"
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
          {action.error && (
            <p role="alert" className="text-sm text-danger">
              {action.error}
            </p>
          )}
        </div>
      </AssistantDialog>
    </>
  );
}
