"use client";

import React, { useState } from "react";
import { X, Copy, Check, AlertCircle, ExternalLink, Loader2 } from "lucide-react";

interface DnsConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  domain: string;
  onContinue: () => void;
}

const DnsConfigModal: React.FC<DnsConfigModalProps> = ({
  isOpen,
  onClose,
  domain,
  onContinue,
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [dnsStatus, setDnsStatus] = useState<"pending" | "verified" | "failed">("pending");

  if (!isOpen) return null;

  // DNS Records to configure
  const dnsRecords = [
    {
      type: "A",
      name: "@",
      value: "76.76.21.21",
      description: "Points your domain to our servers",
    },
    {
      type: "CNAME",
      name: "www",
      value: "proxy.oblien.com",
      description: "Points www subdomain to our proxy",
    },
  ];

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleCheckDns = async () => {
    setChecking(true);
    setDnsStatus("pending");
    
    // Simulate DNS check API call
    try {
      // Replace with actual API call
      // const response = await request(`dns/verify/${domain}`, {}, 'GET');
      
      // Mock delay
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Mock result - replace with actual response
      const isVerified = Math.random() > 0.3; // 70% success rate for demo
      
      if (isVerified) {
        setDnsStatus("verified");
      } else {
        setDnsStatus("failed");
      }
    } catch (error) {
      console.error("DNS verification failed:", error);
      setDnsStatus("failed");
    } finally {
      setChecking(false);
    }
  };

  const handleContinue = () => {
    onContinue();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 sticky top-0 bg-white z-10 rounded-t-2xl">
          <div>
            <h2 className="text-2xl font-bold text-black">Configure Custom Domain</h2>
            <p className="text-sm text-gray-600 mt-1">
              Add these DNS records to your domain provider
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-xl transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Domain Display */}
          <div className="bg-black rounded-xl p-5 shadow-sm">
            <p className="text-xs font-semibold text-gray-400 mb-1 uppercase tracking-wide">Your Domain</p>
            <p className="text-xl  font-bold text-white">{domain}</p>
          </div>

          {/* Instructions */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-indigo-900">
                <p className="font-semibold mb-2">Before you continue:</p>
                <ol className="list-decimal list-inside space-y-1.5 text-indigo-800">
                  <li>Log in to your domain provider (GoDaddy, Namecheap, etc.)</li>
                  <li>Navigate to DNS settings or DNS management</li>
                  <li>Add the records shown below</li>
                  <li>Wait 5-10 minutes for DNS propagation (can take up to 48 hours)</li>
                </ol>
              </div>
            </div>
          </div>

          {/* DNS Records */}
          <div className="space-y-3">
            <h3 className="text-base font-semibold text-black">DNS Records</h3>
            
            {dnsRecords.map((record, index) => (
              <div
                key={index}
                className="border-2 border-gray-200 rounded-xl p-4 bg-white hover:border-gray-300 transition-all"
              >
                <div className="grid grid-cols-12 gap-4 mb-3">
                  <div className="col-span-2">
                    <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                      Type
                    </label>
                    <div className="px-2 py-1.5 bg-black text-white text-sm  rounded-lg text-center font-semibold">
                      {record.type}
                    </div>
                  </div>
                  <div className="col-span-4">
                    <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                      Name
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-gray-50 border-2 border-gray-200 rounded-lg text-sm  font-semibold">
                        {record.name}
                      </div>
                      <button
                        onClick={() => handleCopy(record.name, `name-${index}`)}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Copy"
                      >
                        {copied === `name-${index}` ? (
                          <Check className="w-4 h-4 text-emerald-600" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-600" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="col-span-6">
                    <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">
                      Value
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-gray-50 border-2 border-gray-200 rounded-lg text-sm  truncate font-semibold">
                        {record.value}
                      </div>
                      <button
                        onClick={() => handleCopy(record.value, `value-${index}`)}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Copy"
                      >
                        {copied === `value-${index}` ? (
                          <Check className="w-4 h-4 text-emerald-600" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-600" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-gray-600">{record.description}</p>
              </div>
            ))}
          </div>

          {/* DNS Status */}
          {dnsStatus !== "pending" && (
            <div
              className={`rounded-xl p-5 shadow-sm ${
                dnsStatus === "verified"
                  ? "bg-emerald-50 border-2 border-emerald-200"
                  : "bg-red-50 border-2 border-red-200"
              }`}
            >
              <div className="flex items-start gap-3">
                {dnsStatus === "verified" ? (
                  <>
                    <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/50">
                      <Check className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-emerald-900">DNS Verified!</p>
                      <p className="text-sm text-emerald-700 mt-1">
                        Your domain is properly configured and ready to use.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-10 h-10 rounded-full bg-red-500 flex items-center justify-center">
                      <AlertCircle className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-red-900">DNS Not Found</p>
                      <p className="text-sm text-red-700 mt-1">
                        We couldn't verify your DNS records yet. Please check your configuration and try again.
                        DNS changes can take up to 48 hours to propagate.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Help Links */}
          <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
            <p className="text-sm font-semibold text-black mb-2">Need help?</p>
            <div className="space-y-2">
              <a
                href="https://docs.oblien.com/custom-domains"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1.5 font-medium group"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="group-hover:underline">View documentation</span>
              </a>
              <a
                href="https://docs.oblien.com/dns-providers"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1.5 font-medium group"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="group-hover:underline">DNS provider guides</span>
              </a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <button
            onClick={handleCheckDns}
            disabled={checking}
            className="px-5 py-2.5 border-2 border-gray-200 text-gray-700 hover:text-black text-sm font-semibold rounded-xl hover:border-black transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {checking ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking...
              </>
            ) : (
              "Check DNS"
            )}
          </button>
          <button
            onClick={handleContinue}
            className="px-6 py-2.5 bg-black text-white text-sm font-semibold rounded-xl hover:bg-gray-900 transition-all shadow-lg hover:shadow-xl"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default DnsConfigModal;

