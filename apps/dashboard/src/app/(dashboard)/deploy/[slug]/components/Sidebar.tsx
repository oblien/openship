import React, { useState, useCallback } from "react";
import { GitBranch, Rocket, CheckCircle2, Info, ChevronDown, Github, Lock, Unlock } from "lucide-react";
import DomainSettings from "./DomainSettings";
import generateIcon from "@/utils/icons";
import { useDeployment } from "@/context/DeploymentContext";
import { useRouter } from "next/navigation";

const Sidebar: React.FC = () => {
  const { config, state, updateConfig, startDeployment } = useDeployment();
  const router = useRouter();
  const [isInfoExpanded, setIsInfoExpanded] = useState(false);

  const handleDeploy = useCallback(async () => {
    const deployment_session_id = await startDeployment();
    
    if (deployment_session_id) {
      router.push(`/build/${deployment_session_id}`);
    }
  }, [startDeployment, router]);

  return (
    <div className="lg:sticky lg:top-6 h-fit space-y-6">
      {/* Repository Info Card */}
      <div className="p-5 border border-black/10 rounded-[15px] bg-white">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="p-2.5 bg-black/10 rounded-[20px]">
              {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 24, 'white', {}, true)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-normal text-black text-base truncate">{config.repo}</p>
              <p className="text-sm text-black/60 truncate">{config.owner}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1 items-end">
            <div className="flex items-center gap-1 text-black/50">
              {generateIcon('git%20branch-159-1658431404.png', 14, 'currentColor')}
              <span className="text-xs font-normal text-black">{config.branch}</span>
            </div>
            <div className="flex items-center gap-1 text-black/50">
              {generateIcon('lock%20open-60-1691989601.png', 14, 'currentColor')}
              <span className="text-xs font-normal text-black">Public</span>
            </div>
          </div>
        </div>
      </div>

      {/* Domain Settings */}
      <DomainSettings
        projectName={config.projectName}
        domain={config.domain}
        setDomain={(val) => updateConfig({ domain: val })}
        customDomain={config.customDomain}
        setCustomDomain={(val) => updateConfig({ customDomain: val })}
        domainType={config.domainType}
        setDomainType={(val) => updateConfig({ domainType: val })}
      />

      {/* Deploy Button */}
      <button
        onClick={handleDeploy}
        disabled={state.isDeploying}
        className="w-full text-white font-normal transition-all duration-300"
        style={{
          padding: '14px 22px',
          borderRadius: '30px',
          fontSize: '1.05rem',
          background: state.isDeploying ? '#e5e7eb' : 'var(--button-primary)',
          cursor: state.isDeploying ? 'not-allowed' : 'pointer',
          color: state.isDeploying ? '#9ca3af' : 'white',
        }}
        onMouseEnter={(e) => {
          if (!state.isDeploying) {
            e.currentTarget.style.background = 'linear-gradient(135deg, #222, #444)';
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.15)';
          }
        }}
        onMouseLeave={(e) => {
          if (!state.isDeploying) {
            e.currentTarget.style.background = 'var(--button-primary)';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }
        }}
      >
        {state.isDeploying ? (
          <div className="flex items-center justify-center gap-3">
            <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
            <span>Deploying...</span>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2">
            {generateIcon('space%20rocket-88-1687505465.png', 24, 'currentColor')}
            <span>Deploy Now</span>
          </div>
        )}
      </button>

      {/* Status Info */}
      {/* <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl border border-green-200 p-5">
        <div className="flex items-start gap-3 mb-4">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-green-900 mb-1">Ready to Deploy</h4>
            <p className="text-sm text-green-700">
              Framework detected: <span className="font-medium">{currentFramework?.name || "Unknown"}</span>
            </p>
          </div>
        </div>
      </div> */}

      {/* Deployment Info */}
      <div
        className="rounded-[15px] border overflow-hidden transition-all duration-200"
        style={{
          background: 'linear-gradient(135deg, rgba(54, 179, 126, 0.05), rgba(0, 198, 255, 0.05))',
          borderColor: '#e6effd',
          boxShadow: '0 4px 15px rgba(54, 179, 126, 0.08)',
        }}
      >
        <button
          onClick={() => setIsInfoExpanded(!isInfoExpanded)}
          className="w-full p-5 flex items-center justify-between transition-colors"
          style={{
            backgroundColor: isInfoExpanded ? 'rgba(54, 179, 126, 0.05)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(54, 179, 126, 0.05)';
          }}
          onMouseLeave={(e) => {
            if (!isInfoExpanded) {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
        >
          <div className="flex items-center gap-3">
            <Info className="w-5 h-5 flex-shrink-0" style={{ color: '#36b37e' }} />
            <h4 className="font-bold text-black">What happens next?</h4>
          </div>
          <ChevronDown
            className={`w-5 h-5 transition-transform duration-200 ${isInfoExpanded ? "rotate-180" : ""
              }`}
            style={{ color: '#36b37e' }}
          />
        </button>

        <div
          className={`transition-all duration-200 ease-in-out ${isInfoExpanded ? "max-h-64 opacity-100" : "max-h-0 opacity-0"
            } overflow-hidden`}
        >
          <div className="px-5 pb-5">
            <ul className="text-sm text-gray-700 space-y-2">
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#36b37e' }}></span>
                <span>Clone and build your repository</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#36b37e' }}></span>
                <span>Set environment variables</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#36b37e' }}></span>
                <span>Deploy to global edge network</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#36b37e' }}></span>
                <span>Get your production URL</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(Sidebar);
