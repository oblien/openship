import React, { useCallback } from "react";
import { frameworks } from "./Frameworks";
import { getFrameworkConfig } from "./Frameworks";
import generateIcon from "@/utils/icons";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { GitBranch } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { FrameworkId } from "./types";

const ProjectSettings: React.FC = () => {
  const { config, updateConfig } = useDeployment();

  const handleFrameworkChange = useCallback((frameworkId: FrameworkId) => {
    const frameworkConfig = getFrameworkConfig(frameworkId);

    updateConfig({
      framework: frameworkId,
      options: {
        ...config.options,
        buildCommand: frameworkConfig.options.buildCommand,
        installCommand: frameworkConfig.options.installCommand,
        outputDirectory: frameworkConfig.options.outputDirectory,
        hasServer: !frameworkConfig.options.isStatic,
      },
    });
  }, [updateConfig, config.options]);
  return (
    <div className="mt-4">      
      <div className="space-y-8">
        {/* Project Name & Branch Selection */}
        <div>
          <h2
            className="font-normal text-black mb-5"
            style={{ fontSize: '1.35rem' }}
          >
            Project Settings
          </h2>
          
          <div className="grid md:grid-cols-2 gap-5">
            {/* Project Name */}
            <div>
              <label className="block text-sm font-normal text-black mb-2">
                Project Name
              </label>
              <input
                type="text"
                value={config.projectName}
                onChange={(e) => updateConfig({ projectName: e.target.value })}
                placeholder="my-awesome-project"
                className="w-full px-5 py-3 bg-black/5 border border-black/10 rounded-[15px] focus:ring-2 focus:ring-black focus:border-transparent focus:bg-white outline-none text-black transition-all"
              />
              <p className="text-xs text-black/50 mt-2">
                A unique identifier for your deployment
              </p>
            </div>

            {/* Branch Selection */}
            <div>
              <label className="block text-sm font-normal text-black mb-2">
                Branch to Deploy
              </label>
              <CustomSelect
                value={config.branch}
                onChange={(val) => updateConfig({ branch: val })}
                options={config.branches.map(branch => ({
                  value: branch,
                  label: branch,
                  icon: <GitBranch className="w-4 h-4" />
                }))}
                placeholder="Select branch"
                className="w-full"
              />
              <p className="text-xs text-black/50 mt-2">
                Choose which branch to deploy from your repository
              </p>
            </div>
          </div>
        </div>

      {/* Framework Preset */}
      <div>
        <h2
          className="font-normal mb-5 text-black"
          style={{ fontSize: '1.35rem' }}
        >
          Framework Preset
        </h2>
        <div className="flex flex-wrap space-x-4 space-y-4">
          {frameworks.map((fw) => {
            const isSelected = config.framework === fw.id;
            return (
              <button
                key={fw.id}
                onClick={() => handleFrameworkChange(fw.id)}
                className={`group relative rounded-2xl  border-black/20 transition-all w-25 h-25 ${isSelected ? 'border-emerald-500 bg-emerald-50 border-2' : 'border-black/20 border-1'}`}
                style={{
                  padding: '20px 16px',   
                }}
                type="button"
              >
                <div className="flex flex-col items-center justify-center space-y-2">
                  <div style={{ fontSize: '2rem' }}>
                    {fw.icon(isSelected ? "#36b37e" : "black")}
                  </div>
                  <div className="text-xs font-medium" style={{ color: '#374151' }}>
                    {fw.name}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-sm font-normal text-black/50 mt-4">
          Select your framework to auto-configure build settings
        </p>
      </div>
      </div>
    </div>
  );
};

export default React.memo(ProjectSettings);
