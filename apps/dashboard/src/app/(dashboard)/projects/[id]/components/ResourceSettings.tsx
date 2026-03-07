import React, { useState, useEffect } from 'react';
import { generateIcon } from '@/utils/icons';
import { useToast } from '@/context/ToastContext';
import { projectsApi } from "@/lib/api";

interface ResourceTier {
  name: string;
  tier: 'lightweight' | 'standard' | 'performance' | 'enterprise' | 'autoscale';
  cpu: string;
  memory: string;
  description: string;
  icon: string;
}

interface ResourceSettingsProps {
  projectId: string;
  currentResources?: {
    cpu_cores: number;
    memory_mb: number;
    tier: string;
  };
}

const RESOURCE_TIERS: ResourceTier[] = [
  { 
    name: 'Lightweight', 
    tier: 'lightweight', 
    cpu: '0.5 vCPU', 
    memory: '512 MB',
    description: 'Small apps and static sites',
    icon: 'dollar%20down-95-1658432931.png' 
  },
  { 
    name: 'Standard', 
    tier: 'standard', 
    cpu: '1 vCPU', 
    memory: '1 GB',
    description: 'Most web applications',
    icon: 'scale-95-1691989638.png' 
  },
  { 
    name: 'Performance', 
    tier: 'performance', 
    cpu: '2 vCPU', 
    memory: '2 GB',
    description: 'High-traffic applications',
    icon: 'rocket-123-1683012680.png' 
  },
  { 
    name: 'Enterprise', 
    tier: 'enterprise', 
    cpu: '4 vCPU', 
    memory: '4 GB',
    description: 'Large scale production apps',
    icon: 'server-59-1658435258.png' 
  },
  { 
    name: 'Auto Scale', 
    tier: 'autoscale', 
    cpu: 'Dynamic', 
    memory: 'Dynamic',
    description: 'Scales based on demand',
    icon: 'ai%20network-130-1686045753.png' 
  },
];

export const ResourceSettings: React.FC<ResourceSettingsProps> = ({ 
  projectId, 
  currentResources 
}) => {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [selectedTier, setSelectedTier] = useState(currentResources?.tier || 'lightweight');
  const [customCpu, setCustomCpu] = useState(currentResources?.cpu_cores || 0.5);
  const [customMemory, setCustomMemory] = useState(currentResources?.memory_mb || 512);
  const [showCustomEdit, setShowCustomEdit] = useState(false);

  useEffect(() => {
    if (currentResources) {
      setSelectedTier(currentResources.tier);
      setCustomCpu(currentResources.cpu_cores);
      setCustomMemory(currentResources.memory_mb);
      
      // If custom tier but no values set, show edit panel
      if (currentResources.tier === 'custom' && (!currentResources.cpu_cores || currentResources.cpu_cores === 0.5) && (!currentResources.memory_mb || currentResources.memory_mb === 512)) {
        setShowCustomEdit(true);
      }
    }
  }, [currentResources]);

  const handleTierSelect = async (tier: ResourceTier) => {
    if (loading || selectedTier === tier.tier) return;
    
    setLoading(true);
    setShowCustomEdit(false);
    
    const cpuValue = tier.tier === 'autoscale' ? -1 : parseFloat(tier.cpu);
    const memoryValue = tier.tier === 'autoscale' ? -1 : parseInt(tier.memory);
    
    const response = await projectsApi.setResources(projectId, {
      tier: tier.tier,
      cpu_cores: cpuValue,
      memory_mb: memoryValue
    });

    if (response.success) {
      setSelectedTier(tier.tier);
      showToast('Resources updated successfully', 'success');
    } else {
      showToast(response.error || 'Failed to update resources', 'error');
    }
    setLoading(false);
  };

  const handleCustomSave = async () => {
    if (loading) return;

    if (customCpu < 0.25 || customCpu > 4.0) {
      showToast('CPU must be between 0.25 and 4.00 cores', 'error');
      return;
    }

    if (customMemory < 128 || customMemory > 8192) {
      showToast('Memory must be between 128 MB and 8192 MB', 'error');
      return;
    }

    setLoading(true);
    const response = await projectsApi.setResources(projectId, {
      tier: 'custom',
      cpu_cores: customCpu,
      memory_mb: customMemory
    });

    if (response.success) {
      setSelectedTier('custom');
      setShowCustomEdit(false);
      showToast('Custom resources saved successfully', 'success');
    } else {
      showToast(response.error || 'Failed to save custom resources', 'error');
    }
    setLoading(false);
  };

  const formatMemory = (mb: number) => {
    if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
    return `${mb} MB`;
  };

  return (
    <div className="bg-white rounded-[20px] border border-black/5 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center border border-indigo-200">
          {generateIcon('cpu%20processor%203-115-1658236937.png', 24, 'rgb(79, 70, 229)')}
        </div>
        <div>
        <h3 className="text-lg font-semibold text-black">Machine Power</h3>
          <p className="text-xs text-black/50">
            Configure the machine power for your project.
          </p>
        </div>
      </div>

      {/* Tier Options - Grid Layout (includes Custom) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
        {RESOURCE_TIERS.map((tier) => {
          const isSelected = selectedTier === tier.tier;
          return (
            <button
              key={tier.tier}
              onClick={() => handleTierSelect(tier)}
              disabled={loading}
              className={`relative flex items-center gap-3 p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                isSelected
                  ? 'bg-indigo-50 border-2 border-indigo-500'
                  : 'bg-black/5 hover:bg-black/10 border-2 border-transparent'
              }`}
            >
              {isSelected && (
                <div className="absolute top-2 right-2">
                  <div className="w-4 h-4 bg-indigo-500 rounded-full flex items-center justify-center">
                    {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
                  </div>
                </div>
              )}
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-indigo-500' : 'bg-black/10'}`}>
                {generateIcon(tier.icon, 24, isSelected ? 'white' : 'rgb(0, 0, 0, 0.5)')}
              </div>
              <div className="flex-1 text-left">
                <p className={`text-sm font-semibold mb-0.5 ${isSelected ? 'text-indigo-900' : 'text-black'}`}>
                  {tier.name}
                </p>
                <p className={`text-[11px] ${isSelected ? 'text-indigo-700/80' : 'text-black/50'}`}>
                  {tier.description}
                </p>
                <div className="flex items-center gap-3 mt-1.5">
                  <div className={`text-[11px] ${isSelected ? 'text-indigo-900/70' : 'text-black/60'}`}>
                    <span className="font-medium">{tier.cpu}</span>
                  </div>
                  <div className="w-1 h-1 rounded-full bg-black/20"></div>
                  <div className={`text-[11px] ${isSelected ? 'text-indigo-900/70' : 'text-black/60'}`}>
                    <span className="font-medium">{tier.memory}</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}

        {/* Custom Card */}
        <button
          onClick={() => {
            if (selectedTier !== 'custom') {
              setSelectedTier('custom');
              setShowCustomEdit(true);
            }
          }}
          disabled={loading}
          className={`relative flex items-center gap-3 p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            selectedTier === 'custom'
              ? 'bg-indigo-50 border-2 border-indigo-500'
              : 'bg-black/5 hover:bg-black/10 border-2 border-transparent'
          }`}
        >
          {selectedTier === 'custom' && (
            <div className="absolute top-2 right-2 flex items-center gap-1">
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setShowCustomEdit(true);
                }}
                className="w-7 h-7 bg-indigo-500 hover:bg-indigo-600 rounded-full flex items-center justify-center transition-all cursor-pointer"
              >
                {generateIcon('edit-1648128800.png', 14, 'white')}
              </div>
              <div className="w-4 h-4 bg-indigo-500 rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedTier === 'custom' ? 'bg-indigo-500' : 'bg-black/10'}`}>
            {generateIcon('setting-100-1658432731.png', 24, selectedTier === 'custom' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-left">
            <p className={`text-sm font-semibold mb-0.5 ${selectedTier === 'custom' ? 'text-indigo-900' : 'text-black'}`}>
              Custom
            </p>
            <p className={`text-[11px] ${selectedTier === 'custom' ? 'text-indigo-700/80' : 'text-black/50'}`}>
              Define your own resources
            </p>
            {selectedTier === 'custom' ? (
              <div className="flex items-center gap-3 mt-1.5">
                <div className={`text-[11px] ${selectedTier === 'custom' ? 'text-indigo-900/70' : 'text-black/60'}`}>
                  <span className="font-medium">{customCpu} vCPU</span>
                </div>
                <div className="w-1 h-1 rounded-full bg-black/20"></div>
                <div className={`text-[11px] ${selectedTier === 'custom' ? 'text-indigo-900/70' : 'text-black/60'}`}>
                  <span className="font-medium">{formatMemory(customMemory)}</span>
                </div>
              </div>
            ) : (
              <div className={`text-[11px] mt-1.5 ${selectedTier === 'custom' ? 'text-indigo-900/70' : 'text-black/60'}`}>
                Click to configure
              </div>
            )}
          </div>
        </button>
      </div>

      {/* Custom Edit Panel */}
      {showCustomEdit && selectedTier === 'custom' && (
        <div className="mt-3 p-4 bg-indigo-50 rounded-xl border border-indigo-200 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-indigo-900">Configure Custom Resources</h4>
            <button
              onClick={() => setShowCustomEdit(false)}
              className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-indigo-100 transition-all"
            >
              {generateIcon('x-29-1658234823.png', 14, 'rgb(79, 70, 229)')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-indigo-900/70 mb-2 block">CPU Cores</label>
              <input
                type="number"
                min="0.25"
                max="4.00"
                step="0.25"
                value={customCpu}
                onChange={(e) => setCustomCpu(parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-white border border-indigo-200 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="0.50"
              />
              <p className="text-xs text-indigo-700/60 mt-1">Range: 0.25 - 4.00</p>
            </div>
            <div>
              <label className="text-xs font-medium text-indigo-900/70 mb-2 block">Memory (MB)</label>
              <input
                type="number"
                min="128"
                max="8192"
                step="128"
                value={customMemory}
                onChange={(e) => setCustomMemory(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-white border border-indigo-200 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="512"
              />
              <p className="text-xs text-indigo-700/60 mt-1">Range: 128 - 8192</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setShowCustomEdit(false)}
              disabled={loading}
              className="flex-1 px-4 py-2.5 bg-white border border-indigo-200 hover:bg-indigo-50 text-indigo-900 font-medium text-sm rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={handleCustomSave}
              disabled={loading}
              className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
