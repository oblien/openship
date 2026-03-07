import React from "react";
import { generateIcon } from "@/utils/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";


export const ProductionUrl: React.FC = () => {
  const { domain } = useProjectSettings();
  return (
    <div className="bg-white rounded-[20px] border border-black/5 p-5 hover:shadow-md transition-all">
      <div className="flex items-center gap-2 mb-4">
        {generateIcon('world-229-1658433759.png', 24, 'rgb(79, 70, 229)')}
        <h3 className="text-base font-semibold text-black">Production URL</h3>
      </div>
      <a
        href={`https://${domain}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-medium text-black hover:text-indigo-600 truncate flex items-center gap-2 transition-colors"
      >
        {domain || 'Not configured'}
        {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 14, 'currentColor')}
      </a>
    </div>
  );
};
