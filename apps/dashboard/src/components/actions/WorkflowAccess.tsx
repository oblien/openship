"use client";
import { Icon } from "@repo/ui/icons";
import type { CreateActionWorkflow } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Button } from "@/components/ui/button";
import { ActionField } from "./ActionField";
import { WorkflowPatterns } from "./WorkflowPatterns";

export type WorkflowAccessValue = NonNullable<CreateActionWorkflow["accessPolicy"]>;
export const defaultWorkflowAccess: WorkflowAccessValue = {
  audience: "owner",
  users: [],
  approval: "required",
  forks: "deny",
};
export const validWorkflowAccess = (value: WorkflowAccessValue) =>
  value.audience !== "selected" ||
  (value.users.length > 0 &&
    value.users.length <= 30 &&
    value.users.every((user) => /^[A-Za-z0-9_\[\]-]{1,128}$/.test(user)));

export function WorkflowAccess({
  value,
  onChange,
  repository,
  github,
  isolated,
  owner,
}: {
  value: WorkflowAccessValue;
  onChange: (value: WorkflowAccessValue) => void;
  repository: string | null;
  github: boolean;
  isolated: boolean;
  owner?: string;
}) {
  const { t } = useI18n();
  const c = t.actions.access;
  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{c.hint}</p>
      <ActionField label={c.audience}>
        <CustomSelect
          variant="filled"
          triggerClassName="bg-muted/60 hover:bg-muted"
          aria-label={c.audience}
          value={value.audience}
          onChange={(audience) => onChange({ ...value, audience })}
          options={[
            {
              value: "owner" as const,
              label: owner ? interpolate(c.savedOwner, { user: owner }) : c.owner,
            },
            ...(repository ? [{ value: "selected" as const, label: c.selected }] : []),
            { value: "collaborators" as const, label: repository ? c.collaborators : c.members },
          ]}
        />
      </ActionField>
      {repository && value.audience === "selected" && (
        <ActionField label={c.users} hint={c.usersHint}>
          <WorkflowPatterns
            label={c.users}
            value={value.users}
            placeholder="octocat"
            onChange={(users) =>
              onChange({
                ...value,
                users: [...new Set(users.map((user) => user.replace(/^@/, "").toLowerCase()))],
              })
            }
          />
          {!validWorkflowAccess(value) && (
            <p role="alert" className="mt-2 text-xs text-warning">
              {c.validation}
            </p>
          )}
        </ActionField>
      )}
      <ActionField
        label={c.approval}
        hint={
          value.approval === "required"
            ? c.requiredHint
            : github
              ? c.automaticGitHubHint
              : c.automaticHint
        }
      >
        <CustomSelect
          variant="filled"
          triggerClassName="bg-muted/60 hover:bg-muted"
          aria-label={c.approval}
          value={value.approval}
          onChange={(approval) => onChange({ ...value, approval })}
          options={[
            { value: "required" as const, label: c.required },
            { value: "automatic" as const, label: c.automatic },
          ]}
        />
      </ActionField>
      {repository && (
        <ActionField label={c.forks} hint={isolated ? c.forkHint : c.needIsolated}>
          <CustomSelect
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            aria-label={c.forks}
            value={value.forks}
            onChange={(forks) => onChange({ ...value, forks })}
            options={[
              { value: "deny" as const, label: c.forkDeny },
              ...(isolated || value.forks === "review"
                ? [{ value: "review" as const, label: c.forkReview }]
                : []),
            ]}
          />
        </ActionField>
      )}
      {github && repository && (
        <section className="space-y-2.5 border-t border-border/40 pt-4">
          <h3 className="flex items-center gap-2 text-xs font-medium">
            <Icon name="github" className="size-4 text-muted-foreground" />
            {c.github}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{c.githubHint}</p>
          <Button asChild variant="ghost" size="sm" className="-ms-2">
            <a
              href={`https://github.com/${repository}/settings/actions`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {c.githubSettings}
              <Icon name="external-link" className="size-3.5" />
            </a>
          </Button>
        </section>
      )}
    </div>
  );
}
