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
    <div className="bg-white rounded-[20px] border border-black/5 p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center border border-indigo-200">
          {generateIcon('preferences-95-1658432731.png', 24, 'rgb(79, 70, 229)')}
        </div>
        <div>
          <h3 className="text-lg font-semibold text-black">Machine Mode</h3>
          <p className="text-xs text-black/50">Control availability and cost efficiency</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Auto Sleep Mode */}
        <button
          onClick={() => handleModeChange('auto_sleep')}
          disabled={loading}
          className={`relative flex items-center gap-3 p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            selectedMode === 'auto_sleep'
              ? 'bg-indigo-50 border-2 border-indigo-500'
              : 'bg-black/5 hover:bg-black/10 border-2 border-transparent'
          }`}
        >
          {selectedMode === 'auto_sleep' && (
            <div className="absolute top-2 right-2">
              <div className="w-4 h-4 bg-indigo-500 rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'auto_sleep' ? 'bg-indigo-500' : 'bg-black/10'}`}>
            {generateIcon('auto%20flash-91-1689918656.png', 24, selectedMode === 'auto_sleep' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-left pr-4">
            <div className="flex items-center gap-2 mb-0.5">
              <p className={`text-sm font-semibold ${selectedMode === 'auto_sleep' ? 'text-indigo-900' : 'text-black'}`}>
                Auto Sleep
              </p>
              <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[9px] font-semibold rounded-full">
                RECOMMENDED
              </span>
            </div>
            <p className={`text-[11px] ${selectedMode === 'auto_sleep' ? 'text-indigo-700/80' : 'text-black/50'}`}>
              Stops when idle, wakes instantly
            </p>
            <p className={`text-[11px] ${selectedMode === 'auto_sleep' ? 'text-indigo-600/70' : 'text-black/40'}`}>
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
              ? 'bg-indigo-50 border-2 border-indigo-500'
              : 'bg-black/5 hover:bg-black/10 border-2 border-transparent'
          }`}
        >
          {selectedMode === 'always_on' && (
            <div className="absolute top-2 right-2">
              <div className="w-4 h-4 bg-indigo-500 rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'always_on' ? 'bg-indigo-500' : 'bg-black/10'}`}>
            {generateIcon('connected%20cable-99-1689918656.png', 24, selectedMode === 'always_on' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-left pr-4">
            <p className={`text-sm font-semibold mb-0.5 ${selectedMode === 'always_on' ? 'text-indigo-900' : 'text-black'}`}>
              Always On
            </p>
            <p className={`text-[11px] ${selectedMode === 'always_on' ? 'text-indigo-700/80' : 'text-black/50'}`}>
              Container never stops
            </p>
            <p className={`text-[11px] ${selectedMode === 'always_on' ? 'text-indigo-600/70' : 'text-black/40'}`}>
              Maximum availability • Higher cost
            </p>
          </div>
        </button>
      </div>

      {/* Info Box */}
      <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <div className="flex items-start gap-2">
          {generateIcon('info%20circle-16-1662452248.png', 16, 'var(--color-amber-600)')}
          <div>
            <p className="text-xs font-semibold text-amber-900 mb-0.5">How Auto Sleep works</p>
            <p className="text-[11px] text-amber-800/80 leading-relaxed">
              When there are requests, your container stays running. After inactivity, it sleeps to save costs. 
              On the next request, it wakes up <span className="font-semibold">instantly</span> - no cold start delays.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
