import React from "react";
import { Copy } from "lucide-react";
import { generateIcon } from "@/utils/icons";

interface DnsConfigurationProps {
  domain: string;
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({ domain }) => {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 animate-in fade-in duration-300">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
          {generateIcon("server%20tree-57-1658435258.png", 24, "var(--color-purple-600)")}
        </div>
        <div>
          <h3 className="font-bold text-black">DNS Configuration</h3>
          <p className="text-sm text-gray-500">Add these records to your DNS</p>
        </div>
      </div>

      <div className="space-y-5">
        <div className="p-5 bg-purple-50 rounded-2xl border-2 border-purple-200">
          <div className="text-xs font-semibold text-purple-900 mb-4 uppercase tracking-wider">
            Add these DNS records
          </div>
          <div className="space-y-3">
            {/* A Record */}
            <div className="bg-white rounded-2xl p-4 border-2 border-purple-100">
              <div className="flex items-center justify-between mb-2">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-gray-500">A Record</span>
                  <span className="text-xs text-gray-400 mt-0.5">
                    @ → 88.99.101.216
                  </span>
                </div>
                <button
                  onClick={() => copyToClipboard('88.99.101.216')}
                  className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Copy IP Address"
                >
                  {generateIcon("copy%201-34-1662364367.png", 20, "rgb(0, 0, 0, 0.5)")}
                </button>
              </div>
              <code className="text-xs text-black block">88.99.101.216</code>
            </div>
          </div>
        </div>

        <div className="p-4 bg-blue-50 rounded-2xl border-2 border-blue-200">
          <p className="text-xs text-blue-800 leading-relaxed">
            <span className="font-semibold">Note:</span> DNS changes can take up to 48 hours to propagate globally. Once configured, click Deploy Now to continue.
          </p>
        </div>
      </div>
    </div>
  );
};

export default DnsConfiguration;

