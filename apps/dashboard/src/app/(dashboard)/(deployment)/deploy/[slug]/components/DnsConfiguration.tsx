import React, { useState } from "react";
import { Copy, Check, Server, Info } from "lucide-react";

interface DnsConfigurationProps {
  domain: string;
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({ domain }) => {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const records = [
    {
      id: "cname",
      type: "CNAME",
      name: "@",
      value: "edge.openship.io",
      description: "Routes your domain through our edge network",
    },
    {
      id: "txt",
      type: "TXT",
      name: `_openship-challenge`,
      value: "Provided after deploy in project settings",
      description: "Verifies domain ownership — add this from your project's domain settings",
      pending: true,
    },
  ];

  return (
    <div className="bg-card rounded-xl border border-border/50 shadow-lg overflow-hidden animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Server className="size-4 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">DNS Configuration</h3>
          <p className="text-xs text-muted-foreground">
            Add these records at your DNS provider for <span className="font-medium text-foreground">{domain}</span>
          </p>
        </div>
      </div>

      <div className="p-5 space-y-3">
        {records.map((record) => (
          <div key={record.id} className="bg-muted/30 rounded-xl border border-border/50 p-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-2.5 py-1 bg-foreground text-background text-xs font-bold rounded-lg">
                {record.type}
              </span>
              <span className="text-xs text-muted-foreground">{record.description}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Name / Host</p>
                <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                  <code className="flex-1 text-sm font-medium text-foreground">{record.name}</code>
                  <button
                    onClick={() => copyToClipboard(record.name, `${record.id}-name`)}
                    className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                  >
                    {copied === `${record.id}-name` ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Value / Target</p>
                <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                  {record.pending ? (
                    <span className="flex-1 text-sm text-muted-foreground italic">After deploy</span>
                  ) : (
                    <code className="flex-1 text-sm font-medium text-foreground">{record.value}</code>
                  )}
                  {!record.pending && (
                    <button
                      onClick={() => copyToClipboard(record.value, `${record.id}-value`)}
                      className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                    >
                      {copied === `${record.id}-value` ? (
                        <Check className="size-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}

        <div className="flex items-start gap-2 p-3 bg-primary/5 rounded-xl border border-primary/10">
          <Info className="size-3.5 text-primary shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground leading-relaxed">
            <p className="mb-1">
              <span className="font-medium text-foreground">Step 1:</span> Add the CNAME record pointing to <span className="font-mono font-medium text-foreground">edge.openship.io</span>
            </p>
            <p>
              <span className="font-medium text-foreground">Step 2:</span> After deployment, go to your project settings to get the TXT verification token and complete domain verification.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DnsConfiguration;
