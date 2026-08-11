import React, { useState } from 'react';
import { generateIcon } from '@/utils/icons';
import { useToast } from '@/context/ToastContext';
import { useI18n } from "@/components/i18n-provider";
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
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [selectedMode, setSelectedMode] = useState(currentMode || 'auto_sleep');

  const handleModeChange = async (mode: 'always_on' | 'auto_sleep') => {
    if (loading || selectedMode === mode) return;

    setLoading(true);
    const response = await projectsApi.setSleepMode(projectId, mode);

    if (response.success) {
      setSelectedMode(mode);
      showToast(t.projectSettings.sleep.toast.updated, 'success');
    } else {
      showToast(response.error || t.projectSettings.sleep.toast.updateFailed, 'error');
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
          <h3 className="text-lg font-semibold text-foreground">{t.projectSettings.sleep.title}</h3>
          <p className="text-xs text-muted-foreground">{t.projectSettings.sleep.description}</p>
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
            <div className="absolute top-2 end-2">
              <div className="w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'auto_sleep' ? 'bg-primary' : 'bg-muted'}`}>
            {generateIcon('auto%20flash-91-1689918656.png', 24, selectedMode === 'auto_sleep' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-start pe-4">
            <div className="flex items-center gap-2 mb-0.5">
              <p className={`text-sm font-semibold ${selectedMode === 'auto_sleep' ? 'text-foreground' : 'text-foreground'}`}>
                {t.projectSettings.sleep.autoSleep}
              </p>
              <span className="px-1.5 py-0.5 bg-success-bg text-success text-[9px] font-semibold rounded-full">
                {t.projectSettings.sleep.recommended}
              </span>
            </div>
            <p className={`text-xs ${selectedMode === 'auto_sleep' ? 'text-primary' : 'text-muted-foreground'}`}>
              {t.projectSettings.sleep.autoSleepDesc}
            </p>
            <p className={`text-xs ${selectedMode === 'auto_sleep' ? 'text-primary/70' : 'text-muted-foreground/70'}`}>
              {t.projectSettings.sleep.autoSleepMeta}
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
            <div className="absolute top-2 end-2">
              <div className="w-4 h-4 bg-primary rounded-full flex items-center justify-center">
                {generateIcon('checkmark-7-1662452248.png', 12, 'white')}
              </div>
            </div>
          )}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedMode === 'always_on' ? 'bg-primary' : 'bg-muted'}`}>
            {generateIcon('connected%20cable-99-1689918656.png', 24, selectedMode === 'always_on' ? 'white' : 'rgb(0, 0, 0, 0.5)')}
          </div>
          <div className="flex-1 text-start pe-4">
            <p className={`text-sm font-semibold mb-0.5 ${selectedMode === 'always_on' ? 'text-foreground' : 'text-foreground'}`}>
              {t.projectSettings.sleep.alwaysOn}
            </p>
            <p className={`text-xs ${selectedMode === 'always_on' ? 'text-primary' : 'text-muted-foreground'}`}>
              {t.projectSettings.sleep.alwaysOnDesc}
            </p>
            <p className={`text-xs ${selectedMode === 'always_on' ? 'text-primary/70' : 'text-muted-foreground/70'}`}>
              {t.projectSettings.sleep.alwaysOnMeta}
            </p>
          </div>
        </button>
      </div>

      {/* Info Box */}
      <div className="mt-4 p-3 bg-warning-bg border border-warning-border rounded-xl">
        <div className="flex items-start gap-2">
          {generateIcon('info%20circle-16-1662452248.png', 16, 'hsl(var(--primary))')}
          <div>
            <p className="text-xs font-semibold text-warning mb-0.5">{t.projectSettings.sleep.infoTitle}</p>
            <p className="text-sm text-warning/80 leading-relaxed">
              {t.projectSettings.sleep.infoBefore}
              <span className="font-semibold">{t.projectSettings.sleep.infoEmphasis}</span>
              {t.projectSettings.sleep.infoAfter}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
