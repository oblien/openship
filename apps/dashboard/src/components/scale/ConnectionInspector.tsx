"use client";

import { memo } from "react";
import { ChevronUp, GitBranch, Unplug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberField, Section, SelectField, TextField, ToggleField } from "./InspectorFields";
import {
  CONNECTION_PROTOCOLS,
  connectionLabel,
  connectionProtocols,
  getConnectionSettings,
  type ConnectionOptions,
  type ConnectionProtocol,
  type ScaleConnection,
  type ScaleDraft,
} from "./topology";

interface ConnectionInspectorProps {
  draft: ScaleDraft;
  connection: ScaleConnection;
  onUpdate: (id: string, options: ConnectionOptions) => void;
  onRemove: (ids: string[]) => void;
  onClose: () => void;
  onMinimize: () => void;
}

export default memo(function ConnectionInspector({
  draft,
  connection,
  onUpdate,
  onRemove,
  onClose,
  onMinimize,
}: ConnectionInspectorProps) {
  const source = draft.nodes.find((node) => node.id === connection.source);
  const target = draft.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return null;
  const settings = getConnectionSettings(draft, target, connection);
  const update = (options: ConnectionOptions) => onUpdate(connection.id, options);
  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      aria-label="Connection configuration"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 p-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
          <GitBranch className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">
            {settings.label || "Connection"}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {connectionLabel(draft, target, connection)}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMinimize}
            aria-label="Minimize inspector"
            title="Minimize panel (Esc)"
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close panel"
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-5">
        <Section title="Connected nodes">
          <dl className="space-y-3 text-sm">
            {[
              ["Source", source.name],
              ["Destination", target.name],
            ].map(([label, name]) => (
              <div key={label} className="flex items-start justify-between gap-4">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-end text-foreground/80">{name}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section title="Connection settings">
          <TextField
            label="Connection name"
            value={settings.label}
            required={false}
            placeholder="Optional label"
            onChange={(label) => update({ label })}
          />
          <SelectField
            label="Protocol"
            value={settings.protocol}
            options={connectionProtocols(target).map((value) => ({
              value,
              label: CONNECTION_PROTOCOLS[value],
            }))}
            onChange={(protocol) => update({ protocol: protocol as ConnectionProtocol })}
          />
          <NumberField
            label="Destination port"
            value={settings.port}
            min={1}
            max={65535}
            onChange={(port) => update({ port })}
          />
          <ToggleField
            label="Enable connection"
            description="Use this connection to route traffic between these nodes."
            checked={settings.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        </Section>
        <div className="border-t border-border/50 pt-5">
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-danger"
            onClick={() => onRemove([connection.id])}
          >
            <Unplug />
            Remove connection
          </Button>
        </div>
      </div>
    </aside>
  );
});
