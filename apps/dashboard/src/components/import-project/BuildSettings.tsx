import React, { useState } from "react";
import { Terminal, FolderOutput, Server } from "lucide-react";
import { ServerSideSwitch } from "@/components/project-settings/ServerSideSwitch";
import { useDeployment } from "@/context/DeploymentContext";
import generateIcon from "@/utils/icons";

interface InputField {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  type: 'text' | 'number';
  min?: number;
  max?: number;
  showCondition?: () => boolean;
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

  // Field-specific editing states (for advanced mode)
  const [editingField, setEditingField] = useState<string | null>(null);
  const [tempValues, setTempValues] = useState<{ [key: string]: string }>({});

  // Use external buildData in advanced mode, or config in simple mode
  const buildData = mode === 'advanced' ? externalBuildData : config?.options;

  // Check if the framework needs a build step
  const needsBuild = config?.framework !== "node" && config?.framework !== "static";

  // Define all input fields in a clean object structure
  const inputFields: InputField[] = [
    {
      key: 'buildCommand',
      label: 'Build Command',
      placeholder: 'npm run build',
      description: 'Command to build your project',
      type: 'text',
      showCondition: () => needsBuild,
      icon: <Terminal className="w-5 h-5 text-black/50" />
    },
    {
      key: 'outputDirectory',
      label: 'Output Directory',
      placeholder: '.next',
      description: 'Directory with build output',
      type: 'text',
      showCondition: () => needsBuild,
      icon: <FolderOutput className="w-5 h-5 text-black/50" />
    },
    {
      key: 'startCommand',
      label: 'Start Command',
      placeholder: 'npm start',
      description: 'Command to start your application',
      type: 'text',
      showCondition: () => buildData?.hasServer,
      icon: <Terminal className="w-5 h-5 text-black/50" />
    },
    {
      key: 'installCommand',
      label: 'Install Command',
      placeholder: 'bun install',
      description: 'Command to install your application',
      type: 'text',
      min: 1,
      max: 65535,
      showCondition: () => true,
      optional: false,
      icon: <Server className="w-5 h-5 text-black/50" />
    },
    {
      key: 'rootDirectory',
      label: 'Root Directory',
      placeholder: './',
      description: 'Deploy a subdirectory of your repository',
      type: 'text',
      optional: true,
      icon: <FolderOutput className="w-5 h-5 text-black/50" />
    },
    {
      key: 'productionPort',
      label: 'Production Port',
      placeholder: '3000',
      description: 'Production port for your application',
      type: 'number',
      min: 1,
      max: 65535,
      showCondition: () => buildData?.hasServer,
      optional: true,
      icon: <Server className="w-5 h-5 text-black/50" />
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
      // Simple mode - basic inputs like import-project
      return (
        <div key={field.key}>
          <label className="block text-sm font-normal text-black mb-2">
            {field.label}
            {field.optional && (
              <span className="text-gray-400 font-normal ml-1">(Optional)</span>
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
            className={`w-full px-5 py-3 border border-black/10 rounded-[15px] outline-none text-black transition-all ${isEditing
              ? 'bg-black/5 focus:ring-2 focus:ring-black focus:border-transparent focus:bg-white cursor-text'
              : 'bg-black/5 cursor-not-allowed text-black/50'
              }`}
          />
          <p className="text-xs text-black/50 mt-2">
            {field.description}
          </p>
        </div>
      );
    }

    // Advanced mode - fancy edit/save/cancel buttons like project-settings
    return (
      <div key={field.key}>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-black/70">{field.label}</h3>
          <p className="text-xs text-black/50 mt-1">{field.description}</p>
        </div>

        {isCurrentlyEditing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-4 bg-black/5 rounded-xl border border-black/10">
              {field.icon}
              <input
                type={field.type}
                min={field.min}
                max={field.max}
                value={displayValue || ''}
                onChange={(e) => setTempValues({ ...tempValues, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className="flex-1 text-sm bg-transparent border-0 outline-none placeholder:text-black/40"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSave(field.key)}
                disabled={loading[field.key]}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
              <button
                onClick={() => handleCancel(field.key, value)}
                className="px-4 py-2 bg-black/5 hover:bg-black/10 text-black rounded-full transition-all text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="relative p-4 bg-black/5 rounded-xl group hover:bg-black/10 transition-all">
            <div className="flex items-center gap-3">
              {field.icon}
              <p className="text-sm font-medium text-black flex-1">{displayValue || field.placeholder}</p>
            </div>
            <button
              onClick={() => handleEdit(field.key, value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-black/40 hover:text-indigo-600 transition-colors"
            >
              {generateIcon('pen-411-1658238246.png', 20, 'rgb(0, 0, 0, 0.5)')}
            </button>
          </div>
        )}
      </div>
    );
  };

  // Filter fields based on their show conditions
  const visibleFields = inputFields.filter(field =>
    !field.showCondition || field.showCondition()
  );

  // Group fields for layout
  const buildFields = visibleFields.filter(field =>
    field.key === 'buildCommand' || field.key === 'outputDirectory'
  );
  const otherFields = visibleFields.filter(field =>
    field.key !== 'buildCommand' && field.key !== 'outputDirectory'
  );

  return (
    <div>
      <div className="border-b border-gray-200 mb-4"></div>

      <div className="flex items-center justify-between mb-6">
        <h2
          className="font-normal text-black"
          style={{ fontSize: '1.35rem' }}
        >
          Build Settings
        </h2>
      </div>

      <div className="grid gap-5 mb-6">
        {/* Build fields (if needed) */}
        {buildFields.length > 0 && (
          <div className="grid md:grid-cols-2 gap-5">
            {buildFields.map(renderInput)}
          </div>
        )}

        {/* Other fields */}
        <div className="grid md:grid-cols-2 gap-5">
          {otherFields.map(renderInput)}
        </div>
      </div>

      {mode === 'simple' && (
        <>
          <div className="border-b border-gray-200 mb-6"></div>
          <ServerSideSwitch
            productionPort={config?.options?.productionPort}
            hasServer={config?.options?.hasServer}
            handleServerToggleChange={(checked: boolean) => updateOptions?.({ hasServer: checked })}
          />
        </>
      )}
    </div>
  );
};

export default React.memo(BuildSettings);
