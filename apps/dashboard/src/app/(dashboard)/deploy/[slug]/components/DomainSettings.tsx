import React, { useState } from "react";
import { Check, Info, X } from "lucide-react";
import DnsConfiguration from "./DnsConfiguration";

interface DomainSettingsProps {
  projectName: string;
  domain: string;
  setDomain: (domain: string) => void;
  customDomain: string;
  setCustomDomain: (domain: string) => void;
  domainType: "free" | "custom";
  setDomainType: (type: "free" | "custom") => void;
}

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectName,
  domain,
  setDomain,
  customDomain,
  setCustomDomain,
  domainType,
  setDomainType,
}) => {
  const [showDnsModal, setShowDnsModal] = useState(false);
  return (
    <div className="bg-white rounded-[15px] border border-gray-200 p-6">
      <h3 
        className="font-normal text-black mb-4"
        style={{ fontSize: '1.35rem' }}
      >
        Domain
      </h3>

      {/* Domain Type Selection */}
      <div className="space-y-3 mb-4">
        {/* Free Domain Option */}
        <button
          type="button"
          onClick={() => setDomainType("free")}
          className="w-full p-4 rounded-[15px] border-2 text-left transition-all"
          style={{
            borderColor: domainType === "free" ? '#36b37e' : '#e2e8f0',
            backgroundColor: domainType === "free" ? 'rgba(54, 179, 126, 0.05)' : 'white',
            boxShadow: domainType === "free" ? '0 4px 12px rgba(54, 179, 126, 0.12)' : 'none',
          }}
          onMouseEnter={(e) => {
            if (domainType !== "free") {
              e.currentTarget.style.borderColor = '#d1d5db';
            }
          }}
          onMouseLeave={(e) => {
            if (domainType !== "free") {
              e.currentTarget.style.borderColor = '#e2e8f0';
            }
          }}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center" style={{
                  borderColor: domainType === "free" ? '#36b37e' : '#d1d5db',
                  backgroundColor: domainType === "free" ? '#36b37e' : 'transparent',
                }}>
                  {domainType === "free" && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="font-medium text-black">Free Subdomain</span>
              </div>
              <p className="text-sm text-gray-600 ml-7">
                Use a free .obl.ee subdomain
              </p>
            </div>
          </div>
        </button>

        {/* Custom Domain Option */}
        <button
          type="button"
          onClick={() => setDomainType("custom")}
          className="w-full p-4 rounded-[15px] border-2 text-left transition-all"
          style={{
            borderColor: domainType === "custom" ? '#36b37e' : '#e2e8f0',
            backgroundColor: domainType === "custom" ? 'rgba(54, 179, 126, 0.05)' : 'white',
            boxShadow: domainType === "custom" ? '0 4px 12px rgba(54, 179, 126, 0.12)' : 'none',
          }}
          onMouseEnter={(e) => {
            if (domainType !== "custom") {
              e.currentTarget.style.borderColor = '#d1d5db';
            }
          }}
          onMouseLeave={(e) => {
            if (domainType !== "custom") {
              e.currentTarget.style.borderColor = '#e2e8f0';
            }
          }}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center" style={{
                  borderColor: domainType === "custom" ? '#36b37e' : '#d1d5db',
                  backgroundColor: domainType === "custom" ? '#36b37e' : 'transparent',
                }}>
                  {domainType === "custom" && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="font-medium text-black">Custom Domain</span>
              </div>
              <p className="text-sm text-gray-600 ml-7">
                Use your own domain name
              </p>
            </div>
          </div>
        </button>
      </div>

      {/* Domain Input */}
      <div>
        {domainType === "free" ? (
          <div className="relative">
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="my-project"
              className="w-full px-4 py-3 pr-20 bg-black/5 border border-black/10 rounded-[15px] focus:ring-2 focus:ring-black focus:border-transparent focus:bg-white outline-none text-black transition-all"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-black/50 text-sm">
              .obl.ee
            </span>
          </div>
        ) : (
          <input
            type="text"
            value={customDomain}
            onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
            placeholder="example.com"
            className="w-full px-4 py-3 bg-black/5 border border-black/10 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent focus:bg-white outline-none text-black transition-all"
          />
        )}
        <p className="text-xs text-black/50 mt-2">
          {domainType === "free" 
            ? `Your project will be available at ${domain}.obl.ee`
            : "You'll need to configure DNS settings before deployment"
          }
        </p>

        {/* DNS Config Button for Custom Domain */}
        {domainType === "custom" && customDomain && (
          <button
            onClick={() => setShowDnsModal(true)}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-50 text-purple-700 text-sm font-medium rounded-lg hover:bg-purple-100 transition-colors border border-purple-200"
          >
            <Info className="w-4 h-4" />
            View DNS Configuration
          </button>
        )}
      </div>

      {/* DNS Configuration Modal */}
      {showDnsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowDnsModal(false)}>
          <div className="max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="relative">
              <button
                onClick={() => setShowDnsModal(false)}
                className="absolute -top-3 -right-3 w-10 h-10 bg-white rounded-full shadow-lg flex items-center justify-center hover:bg-gray-100 transition-colors z-10"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
              <DnsConfiguration domain={customDomain} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DomainSettings;

