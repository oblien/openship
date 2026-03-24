import React, { useState } from 'react';
import { generateIcon } from '@/utils/icons';
import { useToast } from '@/context/ToastContext';
import { projectsApi } from "@/lib/api";

interface SleepModeSettingsProps {
  projectId: string;
  currentMode: 'always_on' | 'auto_sleep';
}

export const SleepModeSettings: React.FC<SleepModeSettingsProps> = ({ 
  projectId, 
  currentMode 
}) => {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [selectedMode, setSelectedMode] = useState(currentMode || 'auto_sleep');

  const handleModeChange = async (mode: 'always_on' | 'auto_sleep') => {
    if (loading || selectedMode === mode) return;
    
    setLoading(true);
    const response = await projectsApi.setSleepMode(projectId, mode);

    if (response.success) {
      setSelectedMode(mode);
      showToast('Sleep mode updated successfully', 'success');
    } else {
      showToast(response.error || 'Failed to update sleep mode', 'error');
    }
    setLoading(false);
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20">
          {generateIcon('preferences-95-1658432731.png', 24, 'hsl(var(--primary))')}
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Machine Mode</h3>
          <p className="text-xs text-muted-foreground">Control availability and cost efficiency</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Auto Sleep Mode */}
        <button
          onClick={() => handleModeChange('auto_sleep')}
          disabled={loading}
          className={`relative flex items-center gap-3 p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            selectedMode === 'auto_sleep'
              ? 'bg-primary/10 border-2 border-primary'
              : 'bg-muted/60 hover:bg-muted border-2 border-transparent'
          }`}
        >
          {selectedMode === 'auto_sleep' && (
            <div className="absolute top-2 right-2">
              <div className="w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'auto_sleep' ? 'bg-primary' : 'bg-muted'}`}>
            {generateIcon('auto%20flash-91-1689918656.png', 24, selectedMode === 'auto_sleep' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-left pr-4">
            <div className="flex items-center gap-2 mb-0.5">
              <p className={`text-sm font-semibold ${selectedMode === 'auto_sleep' ? 'text-foreground' : 'text-foreground'}`}>
                Auto Sleep
              </p>
              <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[9px] font-semibold rounded-full">
                RECOMMENDED
              </span>
            </div>
            <p className={`text-[11px] ${selectedMode === 'auto_sleep' ? 'text-primary' : 'text-muted-foreground'}`}>
              Stops when idle, wakes instantly
            </p>
            <p className={`text-[11px] ${selectedMode === 'auto_sleep' ? 'text-primary/70' : 'text-muted-foreground/70'}`}>
              Cost-efficient • No cold start
            </p>
          </div>
        </button>

        {/* Always On Mode */}
        <button
          onClick={() => handleModeChange('always_on')}
          disabled={loading}
          className={`relative flex items-center gap-3 p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            selectedMode === 'always_on'
              ? 'bg-primary/10 border-2 border-primary'
              : 'bg-muted/60 hover:bg-muted border-2 border-transparent'
          }`}
        >
          {selectedMode === 'always_on' && (
            <div className="absolute top-2 right-2">
              <div className="w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'always_on' ? 'bg-primary' : 'bg-muted'}`}>
            {generateIcon('connected%20cable-99-1689918656.png', 24, selectedMode === 'always_on' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-left pr-4">
            <p className={`text-sm font-semibold mb-0.5 ${selectedMode === 'always_on' ? 'text-foreground' : 'text-foreground'}`}>
              Always On
            </p>
            <p className={`text-[11px] ${selectedMode === 'always_on' ? 'text-primary' : 'text-muted-foreground'}`}>
              Container never stops
            </p>
            <p className={`text-[11px] ${selectedMode === 'always_on' ? 'text-primary/70' : 'text-muted-foreground/70'}`}>
              Maximum availability • Higher cost
            </p>
          </div>
        </button>
      </div>

      {/* Info Box */}
      <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
        <div className="flex items-start gap-2">
          {generateIcon('info%20circle-16-1662452248.png', 16, 'hsl(var(--primary))')}
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-0.5">How Auto Sleep works</p>
            <p className="text-[11px] text-amber-700/80 dark:text-amber-300/80 leading-relaxed">
              When there are requests, your container stays running. After inactivity, it sleeps to save costs. 
              On the next request, it wakes up <span className="font-semibold">instantly</span> - no cold start delays.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
