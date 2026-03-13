import React, { useState } from "react";
import { Terminal, FolderOutput, Server, Package, Play, Hash, Settings2, ChevronDown, ChevronUp, Pencil, Hammer } from "lucide-react";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { useDeployment } from "@/context/DeploymentContext";

interface InputField {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  type: 'text' | 'number';
  min?: number;
  max?: number;
  optional?: boolean;
  icon: React.ReactNode;
}

interface BuildSettingsProps {
  variant?: 'deploy' | 'import';
  mode?: 'simple' | 'advanced';
  buildData?: any;
  onSave?: (field: string, value: string) => Promise<void>;
  loading?: { [key: string]: boolean };
  buildConfig?: any;
  updateOptions?: (options: any) => void;
}

const BuildSettings: React.FC<BuildSettingsProps> = ({
  mode = 'simple',
  buildData: externalBuildData,
  onSave,
  loading = {},
  buildConfig,
  updateOptions: externalUpdateOptions
}) => {
  const deploymentContext = mode === 'simple' ? useDeployment() : { config: buildConfig || {}, updateOptions: () => { } };
  const { config, updateOptions } = deploymentContext || { config: buildConfig || {}, updateOptions: externalUpdateOptions };

  const [isEditing] = useState(mode === 'simple');

  const [editingField, setEditingField] = useState<string | null>(null);
  const [tempValues, setTempValues] = useState<{ [key: string]: string }>({});
  const [expanded, setExpanded] = useState(true);

  const buildData = mode === 'advanced' ? externalBuildData : config?.options;
  const needsBuild = config?.framework !== "node" && config?.framework !== "static";

  const hasBuild = buildData?.hasBuild !== false;
  const hasServer = !!buildData?.hasServer;

  // ── Build-group fields (shown when Build is ON) ──────────────────
  const buildFields: InputField[] = [
    {
      key: 'installCommand',
      label: 'Install Command',
      placeholder: 'bun install',
      description: 'Command to install dependencies',
      type: 'text',
      icon: <Package className="size-4" />
    },
    ...(needsBuild ? [
      {
        key: 'buildCommand',
        label: 'Build Command',
        placeholder: 'npm run build',
        description: 'Command to build your project',
        type: 'text' as const,
        icon: <Terminal className="size-4" />
      },
      {
        key: 'outputDirectory',
        label: 'Output Directory',
        placeholder: '.next',
        description: 'Directory with build output',
        type: 'text' as const,
        icon: <FolderOutput className="size-4" />
      },
    ] : []),
  ];

  // ── Start-group fields (shown when Start is ON) ──────────────────
  const startFields: InputField[] = [
    {
      key: 'startCommand',
      label: 'Start Command',
      placeholder: 'npm start',
      description: 'Command to start your application',
      type: 'text',
      icon: <Play className="size-4" />
    },
    {
      key: 'productionPort',
      label: 'Production Port',
      placeholder: '3000',
      description: 'Production port for your application',
      type: 'number',
      min: 1,
      max: 65535,
      optional: true,
      icon: <Hash className="size-4" />
    },
  ];

  // ── General fields (always visible) ──────────────────────────────
  const generalFields: InputField[] = [
    {
      key: 'rootDirectory',
      label: 'Root Directory',
      placeholder: './',
      description: 'Deploy a subdirectory of your repository',
      type: 'text',
      optional: true,
      icon: <FolderOutput className="size-4" />
    },
  ];

  const handleEdit = (field: string, currentValue: string) => {
    setEditingField(field);
    setTempValues({ ...tempValues, [field]: currentValue || '' });
  };

  const handleSave = async (field: string) => {
    if (mode === 'advanced' && onSave) {
      await onSave(field, tempValues[field]);
      setEditingField(null);
    }
  };

  const handleCancel = (field: string, originalValue: string) => {
    setEditingField(null);
    setTempValues({ ...tempValues, [field]: originalValue });
  };

  const handleChange = (field: string, value: string) => {
    if (mode === 'simple' && updateOptions) {
      updateOptions({ [field]: value } as any);
    } else {
      setTempValues({ ...tempValues, [field]: value });
    }
  };

  const renderInput = (field: InputField) => {
    const value = mode === 'simple' ? (config?.options as any)?.[field.key] : buildData?.[field.key];
    const isCurrentlyEditing = mode === 'advanced' && editingField === field.key;
    const displayValue = isCurrentlyEditing ? tempValues[field.key] : value;

    if (mode === 'simple') {
      return (
        <div key={field.key}>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {field.label}
            {field.optional && (
              <span className="text-muted-foreground/50 ml-1">(Optional)</span>
            )}
          </label>
          <input
            type={field.type}
            min={field.min}
            max={field.max}
            value={displayValue || ''}
            onChange={(e) => handleChange(field.key, e.target.value)}
            readOnly={!isEditing}
            placeholder={field.placeholder}
            className={`w-full px-3.5 py-2.5 border border-border/50 rounded-lg text-sm text-foreground transition-all ${isEditing
              ? 'bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-text'
              : 'bg-muted/20 cursor-not-allowed text-muted-foreground'
              }`}
          />
        </div>
      );
    }

    // Advanced mode
    return (
      <div key={field.key}>
        <div className="mb-3">
          <h3 className="text-sm font-medium text-foreground">{field.label}</h3>
          <p className="text-xs text-muted-foreground mt-1">{field.description}</p>
        </div>

        {isCurrentlyEditing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-xl border border-border/50">
              {field.icon}
              <input
                type={field.type}
                min={field.min}
                max={field.max}
                value={displayValue || ''}
                onChange={(e) => setTempValues({ ...tempValues, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className="flex-1 text-sm bg-transparent border-0 outline-none text-foreground placeholder:text-muted-foreground/50"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSave(field.key)}
                disabled={loading[field.key]}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
              <button
                onClick={() => handleCancel(field.key, value)}
                className="px-4 py-2 bg-muted hover:bg-muted/80 text-foreground rounded-xl text-sm font-medium transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="relative p-3 bg-muted/30 rounded-xl group hover:bg-muted/50 transition-all">
            <div className="flex items-center gap-3">
              {field.icon}
              <p className="text-sm font-medium text-foreground flex-1">{displayValue || field.placeholder}</p>
            </div>
            <button
              onClick={() => handleEdit(field.key, value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/50 hover:text-primary transition-colors"
            >
              <Pencil className="size-4" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const visibleBuildFields = hasBuild ? buildFields : [];
  const visibleStartFields = hasServer ? startFields : [];

  if (mode === 'simple') {
    return (
      <div className="bg-card rounded-2xl border border-border/50">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-5 py-4 text-left"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange-500/10 flex items-center justify-center">
              <Settings2 className="size-[18px] text-orange-500" />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-foreground">Deploy Configuration</p>
              <p className="text-sm text-muted-foreground">
                {config?.framework ? `${config.framework} defaults applied` : 'Configure build options'}
              </p>
            </div>
          </div>
          {expanded ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div className="px-5 pb-5 border-t border-border/50 pt-4">
            <div className="grid md:grid-cols-2 gap-4">
              {/* ── Build column ──────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/50">
                  <div className="flex items-center gap-2">
                    <Hammer className="w-3.5 h-3.5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Build</p>
                      <p className="text-[11px] text-muted-foreground leading-tight">
                        {hasBuild ? 'Install & build commands' : 'Deploy source directly'}
                      </p>
                    </div>
                  </div>
                  <Toggle checked={hasBuild} onChange={(v: boolean) => updateOptions?.({ hasBuild: v })} />
                </div>
                {visibleBuildFields.map(renderInput)}
                {generalFields.map(renderInput)}
              </div>

              {/* ── Start column ──────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/50">
                  <div className="flex items-center gap-2">
                    <Play className="w-3.5 h-3.5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Start</p>
                      <p className="text-[11px] text-muted-foreground leading-tight">
                        {hasServer ? `Server on port ${buildData?.productionPort || '3000'}` : 'Static from edge'}
                      </p>
                    </div>
                  </div>
                  <Toggle checked={hasServer} onChange={(v: boolean) => updateOptions?.({ hasServer: v })} />
                </div>
                {visibleStartFields.map(renderInput)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Advanced mode
  const allVisibleFields = [...visibleBuildFields, ...visibleStartFields, ...generalFields];
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h2 className="text-lg font-semibold text-foreground mb-6">
        Build Settings
      </h2>
      <div className="grid gap-5 mb-6">
        <div className="grid md:grid-cols-2 gap-5">
          {allVisibleFields.map(renderInput)}
        </div>
      </div>
    </div>
  );
};

export default React.memo(BuildSettings);
