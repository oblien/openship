"use client";

import { useRef, useState } from "react";
import type { ClusterDatabase, ProjectDatabaseSchemas } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { clusterPostgresVersion } from "@repo/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { randomUUID } from "@/lib/random-uuid";

export function ClusterDatabaseCopy({
  database,
  disabled,
  onCopy,
}: {
  database: ClusterDatabase;
  disabled: boolean;
  onCopy: (input: Static<typeof ProjectDatabaseSchemas.createClusterDatabase.input>) => void;
}) {
  const [name, setName] = useState(`${database.name.slice(0, 52)}-upgraded`);
  const [version, setVersion] = useState("18");
  const [reviewed, setReviewed] = useState(false);
  const request = useRef(randomUUID());
  return (
    <details className="rounded-xl bg-muted/30 p-3 text-sm">
      <summary className="cursor-pointer">Create an upgraded copy</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!reviewed || disabled || !database.config.backup) return;
          onCopy({
            requestId: request.current,
            name,
            clusterId: database.clusterId,
            config: { ...database.config, version: version as "17" | "18" },
            copyFrom: { databaseId: database.id, expectedSequence: database.sequence },
          });
        }}
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          Create a separate database from a consistent snapshot. Verify your application's queries
          against the new copy, then switch its connection and deploy. The original keeps running.
        </p>
        {!database.config.backup ? (
          <p className="text-xs text-warning">
            Save a backup destination in database settings first.
          </p>
        ) : (
          <>
            <label className="block space-y-1.5">
              <span>New database name</span>
              <Input
                variant="filled"
                required
                pattern="[a-z][a-z0-9-]*[a-z0-9]|[a-z]"
                maxLength={63}
                value={name}
                disabled={disabled}
                onChange={(event) => {
                  setName(event.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <CustomSelect
              variant="filled"
              aria-label="PostgreSQL version for new copy"
              value={version}
              disabled={disabled}
              options={[
                ...(clusterPostgresVersion(database.config) === "17"
                  ? [{ value: "17", label: "PostgreSQL 17" }]
                  : []),
                { value: "18", label: "PostgreSQL 18" },
              ]}
              onChange={(value) => {
                setVersion(value);
                setReviewed(false);
              }}
            />
            <label className="flex items-start gap-2">
              <Checkbox checked={reviewed} onCheckedChange={setReviewed} disabled={disabled} />
              <span>
                I have paused writes for the final move, or this copy is only for testing. Later
                writes will stay on the original.
              </span>
            </label>
            <Button
              type="submit"
              disabled={disabled || !reviewed || !name.trim() || name === database.name}
            >
              Create database copy
            </Button>
          </>
        )}
      </form>
    </details>
  );
}
