"use client";

import React, { useState, useEffect } from "react";
import { Check, ExternalLink, Settings, AlertCircle } from "lucide-react";
import { githubApi } from "@/lib/api";
import { generateIcon } from "@/utils/icons";
import { handleConnectGithub } from "@/utils/github";
import { useToast } from "@/context/ToastContext";
import { SectionContainer } from "@/components/ui/SectionContainer";

interface GitHubStatus {
  active: boolean;
  username?: string;
  avatar_url?: string;
  scope?: string;
  connected_at?: string;
}

export default function IntegrationsPage() {
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus>({ active: false });
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  // Check GitHub connection status on mount
  useEffect(() => {
    checkGithubStatus();
  }, []);

  const checkGithubStatus = async () => {
    try {
      setLoading(true);
      const response = await githubApi.getStatus();
      
      if (response && !response.error) {
        setGithubStatus({
          active: response.connected || false,
          username: response.username || response.login,
          avatar_url: response.avatar_url,
          scope: response.scope,
          connected_at: response.connected_at,
        });
      }
    } catch (error) {
      console.error("Failed to check GitHub status:", error);
    } finally {
      setLoading(false);
    }
  };

  

  const handleDisconnectGithub = async () => {
    if (!confirm("Are you sure you want to disconnect GitHub? This will revoke all permissions.")) {
      return;
    }

    try {
      // Call disconnect API
      await githubApi.disconnect();
      
      setGithubStatus({ active: false });
      console.log("GitHub disconnected successfully");
    } catch (error) {
      console.error("Failed to disconnect GitHub:", error);
    }
  };


  return (
    <div className="min-h-screen bg-[#fafafa]">
      <SectionContainer>
        {/* Header */}
        <div className="mb-8 sm:mb-12 relative">
          <h1 
            className="font-bold text-black mb-2 text-2xl sm:text-3xl lg:text-[2.4rem]"
            style={{ 
              letterSpacing: '-0.5px',
            }}
          >
            Integrations
          </h1>
          <p 
            className="text-gray-600 text-sm sm:text-base lg:text-lg"
            style={{ lineHeight: '1.5' }}
          >
            Connect your favorite tools and services to enhance your workflow
          </p>
          {/* Gradient underline */}
          <div 
            className="absolute left-0"
            style={{
              bottom: '-1rem',
              width: '80px',
              height: '3px',
              background: 'linear-gradient(90deg, #36b37e, #00c6ff)',
              borderRadius: '30px',
            }}
          ></div>
        </div>

        {/* GitHub Integration Card */}
        <div 
          className="bg-white rounded-[20px] border overflow-hidden transition-all duration-300 mb-6"
          style={{
            boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
            borderColor: '#f0f0f0',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-5px)';
            e.currentTarget.style.boxShadow = '0 15px 30px rgba(0, 0, 0, 0.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 8px 25px rgba(0, 0, 0, 0.04)';
          }}
        >
          <div className="p-5 sm:p-8">
            <div className="flex flex-col sm:flex-row items-start justify-between">
              <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-5 flex-1 w-full">
                {/* GitHub Icon */}
                <div className="w-14 h-14 sm:w-16 sm:h-16 bg-black rounded-2xl flex items-center justify-center flex-shrink-0 shadow-lg">
                  <svg className="w-8 h-8 sm:w-9 sm:h-9 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                  </svg>
                </div>

                {/* Content */}
                <div className="flex-1 w-full">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h2 className="text-xl sm:text-2xl font-bold text-black">GitHub</h2>
                    {githubStatus.active && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/10 text-emerald-700 text-xs font-semibold rounded-full ring-1 ring-emerald-500/20">
                        <Check className="w-3.5 h-3.5" />
                        Connected
                      </span>
                    )}
                  </div>

                  <p className="text-sm sm:text-base text-gray-600 mb-5 sm:mb-6 leading-relaxed">
                    Deploy repositories, create webhooks, and manage your GitHub projects directly from Oblien.
                  </p>

                  {/* Connected Status */}
                  {githubStatus.active && githubStatus.username && (
                    <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl p-4 sm:p-5 mb-4 sm:mb-5 border border-gray-200">
                      <div className="flex items-center gap-3">
                        {githubStatus.avatar_url && (
                          <img
                            src={githubStatus.avatar_url}
                            alt={githubStatus.username}
                            className="w-10 h-10 sm:w-12 sm:h-12 rounded-full ring-2 ring-gray-200"
                          />
                        )}
                        <div>
                          <p className="text-sm font-semibold text-black">
                            @{githubStatus.username}
                          </p>
                          <p className="text-xs text-gray-500">
                            Access: {githubStatus.scope || "Public"}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Features List */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 mb-5 sm:mb-6">
                    <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-700">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center ring-1 ring-emerald-500/20 flex-shrink-0">
                        <Check className="w-3 h-3 text-emerald-600" />
                      </div>
                      <span>Import repositories</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-700">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center ring-1 ring-emerald-500/20 flex-shrink-0">
                        <Check className="w-3 h-3 text-emerald-600" />
                      </div>
                      <span>Auto deployments</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-700">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center ring-1 ring-emerald-500/20 flex-shrink-0">
                        <Check className="w-3 h-3 text-emerald-600" />
                      </div>
                      <span>Branch management</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-700">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center ring-1 ring-emerald-500/20 flex-shrink-0">
                        <Check className="w-3 h-3 text-emerald-600" />
                      </div>
                      <span>Organization access</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                    {!githubStatus.active ? (
                      <button
                        onClick={() => handleConnectGithub(checkGithubStatus, showToast, setLoading)}
                        disabled={loading}
                        className="px-5 py-2.5 bg-black text-white text-sm font-semibold rounded-xl hover:bg-gray-900 transition-all shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto justify-center"
                      >
                        {loading ? "Checking..." : "Connect GitHub"}
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => handleConnectGithub(checkGithubStatus, showToast, setLoading)}
                          className="px-4 py-2.5 border-2 border-gray-200 text-gray-700 hover:text-black hover:border-black text-sm font-semibold rounded-xl transition-all flex items-center justify-center gap-2 w-full sm:w-auto"
                        >
                          <Settings className="w-4 h-4" />
                          Change Permissions
                        </button>
                        <button
                          onClick={handleDisconnectGithub}
                          className="px-4 py-2.5 border-2 border-red-200 text-red-700 hover:border-red-600 text-sm font-semibold rounded-xl hover:bg-red-50 transition-all w-full sm:w-auto justify-center"
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                    <a
                      href="https://docs.oblien.com/integrations/github"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm flex items-center justify-center gap-2 font-medium transition-colors text-black/50"
                      
                    >
                      Learn more
                      {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, 'rgba(0,0,0,0.5)')}
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Coming Soon Section */}
        <div 
          className="relative rounded-[20px] sm:rounded-[24px] overflow-hidden border transition-all duration-300 p-6 sm:p-8 lg:p-10"
          style={{
            background: 'linear-gradient(135deg, #fff 0%, #f6faff 100%)',
            boxShadow: '0 15px 40px rgba(0, 0, 0, 0.06)',
            borderColor: '#e6effd',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = '0 20px 40px rgba(0, 0, 0, 0.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = '0 15px 40px rgba(0, 0, 0, 0.06)';
          }}
        >
          {/* Background decoration */}
          <div 
            className="absolute pointer-events-none"
            style={{
              top: '-60px',
              right: '-60px',
              width: '300px',
              height: '300px',
              background: 'radial-gradient(circle, rgba(0, 198, 255, 0.1), transparent 70%)',
              borderRadius: '50%',
              zIndex: 0,
            }}
          ></div>

          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-4">
              <div 
                className="inline-block text-white font-bold text-xs px-3 py-1.5 rounded-full tracking-wide"
                style={{
                  background: 'linear-gradient(135deg, #36b37e, #00c6ff)',
                  boxShadow: '0 4px 12px rgba(54, 179, 126, 0.25)',
                }}
              >
                COMING SOON
              </div>
            </div>
            <h3 className="text-xl sm:text-2xl font-bold text-black mb-3">More Integrations</h3>
            <p className="text-sm sm:text-base text-gray-600 mb-6 leading-relaxed">
              We're working on adding more integrations to help you build and deploy faster.
            </p>
            
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {["GitLab", "Bitbucket", "Slack", "Discord"].map((service, index) => (
                <div 
                  key={service} 
                  className="group bg-white/80 backdrop-blur-sm rounded-xl p-4 sm:p-5 border border-gray-200 hover:border-gray-300 transition-all duration-300 relative overflow-hidden"
                  style={{
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.03)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-3px)';
                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.06)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.03)';
                  }}
                >
                  <div 
                    className="absolute bottom-0 left-0 w-full h-0.5 bg-gradient-to-r from-emerald-500 to-cyan-500 scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-300"
                  ></div>
                  <p className="text-sm font-bold text-black mb-1">{service}</p>
                  <p className="text-xs text-gray-500">Coming soon</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionContainer>

      {/* GitHub Permission Modal */}
      {/* <GithubPermissionModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
        onConnect={handleConnectGithub}
      /> */}
    </div>
  );
}
