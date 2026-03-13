"use client";
import React, { useState, useEffect } from "react";
import { Plus, X, ExternalLink, Check, AlertTriangle, Globe, Shield, Copy, RefreshCw } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi, deployApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

export const DomainSettings = () => {
  const { domainsData, updateDomains, id } = useProjectSettings();
  const { showToast } = useToast();

  const [newDomain, setNewDomain] = useState("");
  const [showCustomDomainSection, setShowCustomDomainSection] = useState(false);
  const [includeWww, setIncludeWww] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [sslData, setSSLData] = useState<any>(null);
  const [isLoadingSSL, setIsLoadingSSL] = useState(false);
  const [isRenewingSSL, setIsRenewingSSL] = useState(false);

  const primaryDomain = domainsData?.domains?.find((d) => d.primary) || {};

  const addLog = (message: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
  };

  // Fetch SSL status when primary domain changes
  useEffect(() => {
    const fetchSSLStatus = async () => {
      if (!primaryDomain?.domain) return;
      
      setIsLoadingSSL(true);
      try {
        const result = await deployApi.sslStatus(primaryDomain.domain);

        if (result.success) {
          setSSLData(result);
        }
      } catch (error) {
        console.error('Failed to fetch SSL status:', error);
      } finally {
        setIsLoadingSSL(false);
      }
    };

    fetchSSLStatus();
  }, [primaryDomain?.domain]);


  const handleSubmitDomains = async () => {
    if (!newDomain.trim()) return;

    setIsSubmitting(true);
    setLogs([]);

    const result = await projectsApi.connectDomain(id, {
      domain: newDomain.trim(),
      includeWww: includeWww,
    });

    console.log('result', result);

    if (!result.success) {
      showToast(result.error || 'Failed to connect domain', 'error', result.message || 'Failed to connect domain');
      setIsSubmitting(false);
      return;
    }

    // Add the custom domain and set it as primary
    const newDomainObj = {
      id: Date.now(),
      domain: newDomain.trim(),
      primary: true,
      verified: true,
    };

    const updatedDomains = [
      ...domainsData.domains.map((d) => ({ ...d, primary: false })),
      newDomainObj
    ];

    await updateDomains(updatedDomains);

    setIsSubmitting(false);
    setShowCustomDomainSection(false);
    setNewDomain("");
    setIncludeWww(false);
    setLogs([]);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Check if primary domain is .opsh.io
  const isObleeDomain = primaryDomain?.domain?.endsWith('.opsh.io');

  const handleRenewSSL = async () => {
    if (!primaryDomain?.domain) return;

    setIsRenewingSSL(true);
    try {
      const result = await deployApi.sslRenew(primaryDomain.domain, false);

      if (result.success) {
        showToast('SSL certificate renewed successfully', 'success');
        // Refresh SSL status
        const statusResult = await deployApi.sslStatus(primaryDomain.domain);
        if (statusResult.success) {
          setSSLData(statusResult);
        }
      } else {
        showToast(result.message || result.error || 'Failed to renew SSL certificate', 'error', result.message);
      }
    } catch (error) {
      console.error('Failed to renew SSL:', error);
      showToast('Failed to renew SSL certificate', 'error');
    } finally {
      setIsRenewingSSL(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Primary Domain & SSL Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Primary Domain Card */}
        <div className="bg-white rounded-xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
              {generateIcon("world-229-1658433759.png", 24, "var(--color-indigo-600)")}
            </div>
            <div>
              <h3 className=" font-bold text-black">Primary Domain</h3>
              <p className="text-sm text-gray-500">Your main deployment URL</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="p-4 bg-gray-50 rounded-2xl border-2 border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Domain</span>
              </div>
              <span className="text-sm text-black font-semibold block">
                {primaryDomain?.domain}
              </span >
            </div>

            <div className="flex items-center gap-2">
              {primaryDomain?.verified ? (
                <>
                  {/* <span className="text-sm text-emerald-600 font-medium">Active & Verified</span> */}
                </>
              ) : (
                <>
                  {generateIcon("error%20triangle-16-1662499385.png", 20, "var(--color-amber-600)")}
                  <span className="text-sm text-amber-600 font-medium">Pending Verification</span>
                </>
              )}
            </div>

            <div className="flex gap-3">
              <button
                className="flex items-center justify-center flex-1 bg-black hover:bg-gray-800 gap-2 text-white border-0 font-semibold py-3 rounded-2xl transition-all shadow-md hover:shadow-lg"
                onClick={() => window.open(`https://${primaryDomain?.domain}`, '_blank')}
              >
                {generateIcon("External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png", 16, "white")}
                Visit
              </button>

              <button
                className="flex items-center justify-center flex-1 font-semibold border-0 text-black bg-black/10 hover:bg-black/20 py-3 rounded-2xl transition-all gap-2"
                onClick={() => setShowCustomDomainSection(!showCustomDomainSection)}
              >
                {showCustomDomainSection ? (
                  <>
                    Cancel
                  </>
                ) : (
                  <>
                    Add Domain
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* SSL Certificate Card */}
        <div className="bg-white rounded-xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
              {generateIcon("ssl-133-1691989601.png", 24, "var(--color-emerald-600)")}
            </div>
            <div>
              <h3 className=" font-bold text-black">SSL Certificate</h3>
              <p className="text-sm text-gray-500">Secure HTTPS encryption</p>
            </div>
          </div>

          <div className="space-y-4">
            {isLoadingSSL ? (
              <div className="flex items-center justify-center p-4 bg-gray-50 rounded-2xl border-2 border-gray-200">
                <span className="text-sm text-gray-500">Loading SSL status...</span>
              </div>
            ) : (
              <div className={`flex items-center justify-between p-4 rounded-2xl border-2 ${
                sslData?.status === 'expired' 
                  ? 'bg-red-50 border-red-200' 
                  : sslData?.status === 'expiring_soon'
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-emerald-50 border-emerald-200'
              }`}>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    sslData?.status === 'expired' 
                      ? 'bg-red-500' 
                      : sslData?.status === 'expiring_soon'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-emerald-500 animate-pulse'
                  }`}></div>
                  <span className={`text-sm font-semibold ${
                    sslData?.status === 'expired' 
                      ? 'text-red-700' 
                      : sslData?.status === 'expiring_soon'
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                  }`}>
                    {sslData?.status === 'expired' 
                      ? 'Expired - Action Required' 
                      : sslData?.status === 'expiring_soon'
                      ? `Expiring Soon (${sslData?.daysUntilExpiry} days)`
                      : sslData?.enabled ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {isObleeDomain ? (
                  <span className="text-xs bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-full font-semibold">
                    Included
                  </span>
                ) : (
                  sslData?.autoRenew && (
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-full font-medium">
                      Auto-renew
                    </span>
                  )
                )}
              </div>
            )}

            {isObleeDomain ? (
              <div className="p-5 bg-indigo-50 rounded-2xl border-2 border-indigo-200">
                <div className="flex items-start gap-3">
                  {generateIcon("check%20circle-68-1658234612.png", 32, "var(--color-indigo-900)")}
                  <div>
                    <div className="text-sm font-semibold text-indigo-900 mb-1">
                      Free SSL Included
                    </div>
                    <div className="text-xs text-indigo-900">
                      Your .opsh.io domain includes free SSL with no expiration. Certificate renewal is available for custom domains.
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="p-4 bg-gray-50 rounded-2xl border-2 border-gray-200">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-6 flex-1">
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5">Issuer</div>
                        <div className="text-sm font-semibold text-black">{sslData?.issuer || "Let's Encrypt"}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5">Expires</div>
                        <div className="text-sm font-semibold text-black">
                          {sslData?.expiresAt ? new Date(sslData.expiresAt).toLocaleDateString() : 'N/A'}
                        </div>
                      </div>
                    </div>
                    
                    {sslData?.enabled && (
                      <button
                        onClick={handleRenewSSL}
                        disabled={isRenewingSSL}
                        title={sslData?.daysUntilExpiry > 7 ? `Renewal available in ${sslData?.daysUntilExpiry - 7} days` : ''}
                        className={`${
                          sslData?.status === 'expired' || sslData?.status === 'expiring_soon'
                            ? 'bg-amber-600 hover:bg-amber-700'
                            : 'bg-emerald-600 hover:bg-emerald-700'
                        } text-white text-sm font-semibold border-0 px-4 py-2 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap`}
                      >
                        {isRenewingSSL ? 'Renewing...' : (sslData?.status === 'expired' ? 'Renew Now' : 'Renew')}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Custom Domain & DNS Configuration */}
      {showCustomDomainSection && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Add Custom Domain - Left Section */}
          <div className="space-y-6">
            <div className="bg-white rounded-xl  p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
                  <Plus className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h3 className=" font-bold text-black">Custom Domain</h3>
                  <p className="text-sm text-gray-500">Configure your own domain</p>
                </div>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-3">
                    Domain Name
                  </label>
                  <input
                    placeholder="yourdomain.com"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    className="w-full bg-white border-2 border-gray-300 text-black rounded-2xl px-4 py-3"
                  />
                </div>

                {/* WWW Toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border-2 border-gray-200">
                  <div>
                    <div className="text-sm font-semibold text-black">Include WWW subdomain</div>
                    <div className="text-xs text-gray-500 mt-0.5">Also configure www.{newDomain || 'yourdomain.com'}</div>
                  </div>
                  <button
                    onClick={() => setIncludeWww(!includeWww)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${includeWww ? 'bg-black' : 'bg-gray-300'
                      }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${includeWww ? 'translate-x-6' : 'translate-x-1'
                        }`}
                    />
                  </button>
                </div>

                {/* Submit Button */}
                <button
                  onClick={handleSubmitDomains}
                  className="flex items-center justify-center w-full bg-black hover:bg-gray-800 gap-2 text-white font-semibold border-0 py-4 text-sm rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
                  disabled={!newDomain.trim() || isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      Configuring...
                    </>
                  ) : (
                    <>
                      Submit & Configure
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* DNS Configuration OR Logs Section - Right Section */}
          {(isSubmitting || logs.length > 0) ? (
            /* Logs Section - Shows after submit */
            <div className="bg-white rounded-xl  p-6 h-fit sticky top-6 animate-in fade-in duration-300">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
                  {generateIcon("terminal-184-1658431404.png", 24, "black")}
                </div>
                <div>
                  <h3 className=" font-bold text-black">Process Logs</h3>
                  <p className="text-sm text-gray-500">SSL & Configuration logs</p>
                </div>
              </div>

              <div className="bg-white rounded-2xl  p-5 text-xs text-black h-80 overflow-y-auto ">
                <div className="space-y-1.5">
                  {logs.map((log, index) => (
                    <div key={index} className="leading-relaxed">
                      {log}
                    </div>
                  ))}
                  {isSubmitting && (
                    <div className="leading-relaxed animate-pulse">
                      {generateIcon("flash%20refresh-94-1658434699.png", 20, "rgba(255, 255, 255, 0.25)")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* DNS Configuration - Shows before submit */
            <div className="bg-white rounded-xl  p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                  {generateIcon("server%20tree-57-1658435258.png", 24, "var(--color-purple-600)")}
                </div>
                <div>
                  <h3 className=" font-bold text-black">DNS Configuration</h3>
                  <p className="text-sm text-gray-500">Add these records to your DNS</p>
                </div>
              </div>

              <div className="space-y-5">
                <div className="p-5 bg-purple-50 rounded-2xl border-2 border-purple-200">
                  <div className="text-xs font-semibold text-purple-900 mb-4 uppercase tracking-wider">
                    Add these DNS records
                  </div>
                  <div className="space-y-3">
                    {/* CNAME Record */}
                    <div className="bg-white rounded-2xl p-4 border-2 border-purple-100">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex flex-col">
                          <span className="text-xs font-semibold text-gray-500">CNAME Record</span>
                          <span className="text-xs text-gray-400 mt-0.5">
                            @ → edge.openship.io
                          </span>
                        </div>
                        <button
                          onClick={() => copyToClipboard('edge.openship.io')}
                          className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                          title="Copy"
                        >
                          {generateIcon("copy%201-34-1662364367.png", 20, "rgb(0, 0, 0, 0.5)")}
                        </button>
                      </div>
                      <code className="text-xs text-black block">edge.openship.io</code>
                    </div>

                    {/* TXT Record */}
                    <div className="bg-white rounded-2xl p-4 border-2 border-purple-100">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex flex-col">
                          <span className="text-xs font-semibold text-gray-500">TXT Record</span>
                          <span className="text-xs text-gray-400 mt-0.5">
                            _openship-challenge → verification token
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-gray-500">The verification token will be provided after you submit the domain below.</p>
                    </div>

                    {/* WWW CNAME Record - Only show when includeWww is true */}
                    {includeWww && (
                      <div className="bg-white rounded-2xl p-4 border-2 border-purple-100 animate-in fade-in duration-200">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex flex-col">
                            <span className="text-xs font-semibold text-gray-500">CNAME Record (WWW)</span>
                            <span className="text-xs text-gray-400 mt-0.5">
                              www → edge.openship.io
                            </span>
                          </div>
                          <button
                            onClick={() => copyToClipboard('edge.openship.io')}
                            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                            title="Copy"
                          >
                            <Copy className="h-3 w-3 text-gray-400" />
                          </button>
                        </div>
                        <code className="text-xs text-black block">edge.openship.io</code>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 bg-blue-50 rounded-2xl border-2 border-blue-200">
                  <p className="text-xs text-blue-800 leading-relaxed">
                    <span className="font-semibold">Note:</span> DNS changes can take up to 48 hours to propagate globally.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
