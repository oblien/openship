import React from "react";
import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
}) => {
  return (
    <div className="bg-white rounded-xl p-12 text-center border border-black/5">
      {/* Icon Container */}
      <div className="inline-flex items-center justify-center w-20 h-20 bg-black/[0.02] rounded-2xl mb-5 border border-black/5">
        <Icon className="w-10 h-10 text-black/40" strokeWidth={1.5} />
      </div>

      {/* Content */}
      <h3 className="text-xl font-semibold text-black mb-2">
        {title}
      </h3>
      <p className="text-black/60 text-base max-w-md mx-auto">
        {description}
      </p>

      {/* Optional Action Button */}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-6 px-6 py-2.5 bg-black text-white rounded-full text-sm font-medium hover:bg-black/90 transition-all"
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

export default EmptyState;

