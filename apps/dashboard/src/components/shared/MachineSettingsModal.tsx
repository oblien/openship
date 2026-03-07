'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ExternalLink, BookOpen } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/context/ToastContext';
import { projectsApi, sandboxApi } from '@/lib/api';

// Resource tier definitions (credits per month)
const CPU_TIERS = [
  { value: 1, label: '1 vCPU', credits: 0 },
  { value: 2, label: '2 vCPU', credits: 500 },
  { value: 4, label: '4 vCPU', credits: 1500 },
  { value: 8, label: '8 vCPU', credits: 3500 },
];

const RAM_TIERS = [
  { value: 2, label: '2 GB', credits: 0 },
  { value: 4, label: '4 GB', credits: 500 },
  { value: 8, label: '8 GB', credits: 1500 },
  { value: 16, label: '16 GB', credits: 3500 },
  { value: 32, label: '32 GB', credits: 7500 },
];

const STORAGE_TIERS = [
  { value: 20, label: '20 GB', credits: 0 },
  { value: 50, label: '50 GB', credits: 500 },
  { value: 100, label: '100 GB', credits: 1200 },
  { value: 250, label: '250 GB', credits: 2500 },
];

interface MachineConfig {
  cpu: number;
  ram: number;
  storage: number;
}

interface MachineSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'sandbox' | 'project';
  resourceId: string;
  resourceName: string;
  currentConfig: MachineConfig;
  onUpdate?: (config: MachineConfig) => void;
}

const formatCredits = (credits: number): string => {
  if (credits >= 1000) {
    return `${(credits / 1000).toFixed(1)}K`;
  }
  return credits.toString();
};

interface ResourceRowProps {
  label: string;
  tiers: { value: number; label: string; credits: number }[];
  currentValue: number;
  selectedValue: number;
  onChange: (value: number) => void;
}

const ResourceRow = ({ label, tiers, currentValue, selectedValue, onChange }: ResourceRowProps) => {
  return (
    <div className="flex items-center gap-6">
      <div className="w-24 shrink-0">
        <span className="text-sm font-medium text-black/70">{label}</span>
      </div>
      <div className="flex-1 flex gap-2">
        {tiers.map((tier) => {
          const isSelected = selectedValue === tier.value;
          const isCurrent = currentValue === tier.value;
          
          return (
            <button
              key={tier.value}
              onClick={() => onChange(tier.value)}
              className={`relative flex-1 py-3 px-2 rounded-xl text-center transition-all border ${
                isSelected
                  ? 'bg-black/90 text-white border-black/90'
                  : 'bg-white text-black/80 border-black/10 hover:border-black/20 hover:bg-black/[0.02]'
              }`}
            >
              <div className="text-sm font-medium">{tier.label}</div>
              {tier.credits > 0 ? (
                <div className={`text-xs mt-0.5 ${isSelected ? 'text-white/50' : 'text-black/40'}`}>
                  +{formatCredits(tier.credits)}
                </div>
              ) : (
                <div className={`text-xs mt-0.5 ${isSelected ? 'text-white/50' : 'text-black/40'}`}>
                  Base
                </div>
              )}
              {isCurrent && !isSelected && (
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-black/5 text-black/50 text-[10px] font-medium rounded-full">
                  Current
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default function MachineSettingsModal({
  isOpen,
  onClose,
  type,
  resourceId,
  resourceName,
  currentConfig,
  onUpdate,
}: MachineSettingsModalProps) {
  const { showToast } = useToast();
  const [selectedCpu, setSelectedCpu] = useState(currentConfig.cpu);
  const [selectedRam, setSelectedRam] = useState(currentConfig.ram);
  const [selectedStorage, setSelectedStorage] = useState(currentConfig.storage);
  const [isSaving, setIsSaving] = useState(false);

  // Reset selections when modal opens with new config
  useEffect(() => {
    if (isOpen) {
      setSelectedCpu(currentConfig.cpu);
      setSelectedRam(currentConfig.ram);
      setSelectedStorage(currentConfig.storage);
    }
  }, [isOpen, currentConfig]);

  // Calculate credits
  const getCredits = (tiers: typeof CPU_TIERS, value: number) => 
    tiers.find(t => t.value === value)?.credits || 0;

  const currentTotal = 
    getCredits(CPU_TIERS, currentConfig.cpu) + 
    getCredits(RAM_TIERS, currentConfig.ram) + 
    getCredits(STORAGE_TIERS, currentConfig.storage);

  const newTotal = 
    getCredits(CPU_TIERS, selectedCpu) + 
    getCredits(RAM_TIERS, selectedRam) + 
    getCredits(STORAGE_TIERS, selectedStorage);

  const creditsDiff = newTotal - currentTotal;
  const hasChanges = 
    selectedCpu !== currentConfig.cpu || 
    selectedRam !== currentConfig.ram || 
    selectedStorage !== currentConfig.storage;

  const handleSave = async () => {
    setIsSaving(true);
    
    try {
      const resources = {
        cpu: selectedCpu,
        ram: selectedRam,
        storage: selectedStorage,
      };

      const response = type === 'sandbox'
        ? await sandboxApi.updateResources(resourceId, resources)
        : await projectsApi.updateResources(resourceId, resources);

      if (response.success) {
        showToast('Machine settings updated', 'success');
        onUpdate?.({ cpu: selectedCpu, ram: selectedRam, storage: selectedStorage });
        onClose();
      } else {
        showToast(response.message || 'Failed to update settings', 'error');
      }
    } catch (error) {
      console.error('Error updating resources:', error);
      showToast('Failed to update settings', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const docsUrl = type === 'sandbox' 
    ? '/docs/sandbox/configuration' 
    : '/docs/projects/configuration';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="48rem"
      height="auto"
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className="px-8 py-6 border-b border-black/5 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-black" style={{ letterSpacing: '-0.5px' }}>
              Machine Settings
            </h2>
            <p className="text-sm text-black/50 mt-1">
              Configure compute resources for <span className="font-medium text-black/60">{resourceName}</span>
            </p>
          </div>
          <Link
            href={docsUrl}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-black/50 hover:text-black bg-black/5 hover:bg-black/10 rounded-lg transition-all"
          >
            <BookOpen className="w-4 h-4" />
            Docs
          </Link>
        </div>

        {/* Content */}
        <div className="px-8 py-6 space-y-5">
          <ResourceRow
            label="CPU"
            tiers={CPU_TIERS}
            currentValue={currentConfig.cpu}
            selectedValue={selectedCpu}
            onChange={setSelectedCpu}
          />

          <ResourceRow
            label="Memory"
            tiers={RAM_TIERS}
            currentValue={currentConfig.ram}
            selectedValue={selectedRam}
            onChange={setSelectedRam}
          />

          <ResourceRow
            label="Storage"
            tiers={STORAGE_TIERS}
            currentValue={currentConfig.storage}
            selectedValue={selectedStorage}
            onChange={setSelectedStorage}
          />
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-black/5 flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-black/80">{formatCredits(newTotal)}</span>
              <span className="text-sm text-black/40">credits/month</span>
            </div>
            {hasChanges && creditsDiff !== 0 && (
              <p className={`text-sm ${creditsDiff > 0 ? 'text-black/50' : 'text-emerald-600'}`}>
                {creditsDiff > 0 ? `+${formatCredits(creditsDiff)}` : `-${formatCredits(Math.abs(creditsDiff))}`} from current
              </p>
            )}
            <Link 
              href="/pricing" 
              className="inline-flex items-center gap-1 text-xs text-black/40 hover:text-black/60 mt-1 transition-colors"
            >
              View pricing
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2.5 text-sm font-medium text-black/50 hover:text-black transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              className="px-6 py-2.5 text-sm font-medium text-white bg-black/90 rounded-xl hover:bg-black transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
