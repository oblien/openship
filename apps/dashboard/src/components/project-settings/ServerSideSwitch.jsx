import { Hammer, Play } from "lucide-react";

const Toggle = ({ checked, onChange }) => (
  <label className="relative inline-flex items-center cursor-pointer shrink-0">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
    <div className="w-9 h-5 bg-border rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-muted-foreground/80 after:rounded-full after:h-4 after:w-4 after:shadow-sm after:transition-all peer-checked:bg-primary peer-checked:after:bg-primary-foreground peer-checked:after:border-transparent" />
  </label>
);

export { Toggle };

export const DeploymentModeSwitch = ({
  hasBuild,
  hasServer,
  onBuildChange,
  onServerChange,
  productionPort,
  className = '',
}) => {
  return (
    <div className={`flex gap-2 ${className}`}>
      <div className="flex-1 flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/50">
        <div className="flex items-center gap-2">
          <Hammer className="w-3.5 h-3.5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">Build</p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              {hasBuild ? 'Install & build commands' : 'Deploy source directly'}
            </p>
          </div>
        </div>
        <Toggle checked={hasBuild} onChange={onBuildChange} />
      </div>
      <div className="flex-1 flex items-center justify-between p-2.5 bg-muted/30 rounded-lg border border-border/50">
        <div className="flex items-center gap-2">
          <Play className="w-3.5 h-3.5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">Start</p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              {hasServer ? `Server on port ${productionPort || '3000'}` : 'Static from edge'}
            </p>
          </div>
        </div>
        <Toggle checked={hasServer} onChange={onServerChange} />
      </div>
    </div>
  );
};

// Backwards compat
export const ServerSideSwitch = ({ productionPort, hasServer, handleServerToggleChange, hasBuild, handleBuildToggleChange, className = '', style = {} }) => (
  <DeploymentModeSwitch
    hasBuild={hasBuild ?? true}
    hasServer={hasServer}
    onBuildChange={handleBuildToggleChange || (() => {})}
    onServerChange={handleServerToggleChange}
    productionPort={productionPort}
    className={className}
  />
);