"use client";

import { useId } from "react";
import { Icon } from "@repo/ui/icons";
import type { SshTransport } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";

export function SshTransportField({ value, onChange, disabled }: {
  value: SshTransport;
  onChange: (value: SshTransport) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const copy = t.servers.sshTransport;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-muted-foreground mb-1.5">{copy.label}</label>
      <CustomSelect
        id={id}
        aria-label={copy.label}
        variant="input"
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "direct", label: copy.direct, icon: <Icon name="server" className="size-4 text-muted-foreground" /> },
          { value: "cloudflare", label: "Cloudflare Access", icon: <Icon name="cloud" className="size-4 text-warning" /> },
        ]}
      />
      {value === "cloudflare" && (
        <p className="mt-2 text-xs text-muted-foreground">{copy.help}</p>
      )}
    </div>
  );
}
