import React, { useState } from "react";
import { Github, Link2, ArrowRight, Sparkles, GitBranch } from "lucide-react";

interface GithubConnectionPromptProps {
  onConnect: () => void;
  onAddManual: (url?: string) => void;
  loading: boolean;
}

const GithubConnectionPrompt: React.FC<GithubConnectionPromptProps> = ({
  onConnect,
  onAddManual,
  loading,
}) => {
  const [repoUrl, setRepoUrl] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (repoUrl.trim()) {
      onAddManual(repoUrl);
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6 items-stretch">
      {/* GitHub Connect Card */}
      <div className="bg-black rounded-2xl p-8 text-white shadow-xl relative overflow-hidden flex flex-col h-full">
        {/* Background decoration */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-white/5 rounded-full blur-3xl"></div>
        
        <div className="relative z-10 flex flex-col flex-1">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-6 backdrop-blur-sm ring-2 ring-white/20">
            <Github className="w-9 h-9 text-white" />
          </div>
          
          <h2 className="text-2xl font-bold mb-3">
            Connect GitHub
          </h2>
          <p className="text-gray-300 mb-6 leading-relaxed">
            Import your repositories directly from GitHub. Get automatic deployments on every push and seamless integration.
          </p>
          
          {/* Features */}
          <div className="space-y-3 mb-8">
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center ring-1 ring-emerald-500/30">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <span className="text-sm text-gray-300">Automatic deployments on push</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center ring-1 ring-emerald-500/30">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <span className="text-sm text-gray-300">Access to all your repositories</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center ring-1 ring-emerald-500/30">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <span className="text-sm text-gray-300">Branch and commit tracking</span>
            </div>
          </div>

          <button
            onClick={onConnect}
            disabled={loading}
            className="w-full disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 px-6 py-4 bg-white text-black font-bold rounded-xl hover:bg-gray-100 transition-all shadow-lg hover:shadow-2xl mt-auto"
          >
            <Github className="w-5 h-5" />
            {loading ? "Connecting..." : "Connect GitHub Account"}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Manual URL Card */}
      <div className="bg-white rounded-2xl border-2 border-gray-200 p-8 hover:border-gray-300 transition-all flex flex-col h-full">
        <div>
          <div 
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-6"
            style={{
              background: 'linear-gradient(135deg, rgba(54, 179, 126, 0.1), rgba(0, 198, 255, 0.1))',
              boxShadow: '0 0 0 2px rgba(54, 179, 126, 0.2)'
            }}
          >
            <Link2 className="w-9 h-9" style={{ color: '#36b37e' }} />
          </div>
          
          <h2 className="text-2xl font-bold text-black mb-3">
            Deploy from URL
          </h2>
          <p className="text-gray-600 mb-6 leading-relaxed">
            Have a public GitHub repository? Paste the URL below to deploy it without connecting your account.
          </p>
        </div>

        <div className="flex-1 flex flex-col justify-end">
          {!showUrlInput ? (
            <button
              onClick={() => setShowUrlInput(true)}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-4 border-2 border-gray-200 text-gray-700 hover:text-black hover:border-black font-semibold rounded-xl transition-all"
            >
              <GitBranch className="w-5 h-5" />
              Add Repository URL
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Repository URL
                </label>
                <input
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/username/repository"
                  className="w-full px-4 py-3 bg-white border-2 border-gray-200 rounded-xl outline-none text-black  text-sm transition-all"
                  onFocus={(e) => {
                    e.target.style.borderColor = '#36b37e';
                    e.target.style.boxShadow = '0 0 0 3px rgba(54, 179, 126, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#e5e7eb';
                    e.target.style.boxShadow = 'none';
                  }}
                  required
                />
                <p className="text-xs text-gray-500 mt-1.5">
                  Only public repositories are supported without GitHub connection
                </p>
              </div>
              
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowUrlInput(false)}
                  className="flex-1 px-4 py-3 border-2 border-gray-200 text-gray-700 hover:text-black hover:border-black font-semibold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-3 text-white font-semibold rounded-xl transition-all hover:shadow-md"
                  style={{
                    background: 'linear-gradient(135deg, #36b37e, #00c6ff)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'linear-gradient(135deg, #2d9568, #00b3e6)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'linear-gradient(135deg, #36b37e, #00c6ff)';
                  }}
                >
                  Deploy
                </button>
              </div>
            </form>
          )}

          {/* Info */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-xs text-gray-500 leading-relaxed">
              <span className="font-semibold text-black">Note:</span> Manual deployments won't receive automatic updates. 
              Connect GitHub for the best experience.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GithubConnectionPrompt;
