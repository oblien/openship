import React from "react";
import { Home, RefreshCw, AlertCircle } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";

export const ProjectNotFound: React.FC = () => {
  const { domain } = useProjectSettings();
  return (
    <div className="flex items-center justify-center min-h-[500px] p-6">
      <div className="max-w-xl w-full">
        <div className="bg-white rounded-2xl border-2 border-gray-200 shadow-xl p-8">
          {/* Icon and Title */}
          <div className="text-center mb-6">
            <div className="w-20 h-20 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-4 border-2 border-red-100">
              <AlertCircle className="w-10 h-10 text-red-600" strokeWidth={2} />
            </div>

            <h1 className="text-2xl font-bold text-black mb-2">
              Project Not Found
            </h1>

            <p className="text-gray-600 text-sm">
              We couldn't locate this project
            </p>
          </div>

          {/* Content Section */}
          <div>
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-5 mb-6">
              <p className="text-gray-600 text-sm leading-relaxed mb-3 text-center">
                The project <code className="px-2 py-1 bg-white rounded-lg  text-xs text-black font-semibold border border-gray-200">{domain}</code> doesn't exist in your workspace.
              </p>
              <div className="space-y-1.5 text-xs text-gray-600">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
                  <span>The project may have been deleted</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
                  <span>You may not have access to this project</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
                  <span>The domain URL might be incorrect</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 mb-6">
              <button
                onClick={() => window.location.href = '/'}
                className="flex items-center justify-center flex-1 bg-black hover:bg-gray-800 text-white font-semibold py-3 rounded-xl transition-all gap-2"
              >
                <Home className="w-4 h-4" />
                Dashboard
              </button>

              <button
                onClick={() => window.location.reload()}
                className="flex items-center justify-center flex-1 bg-gray-100 hover:bg-gray-200 text-black font-semibold py-3 rounded-xl transition-all gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Reload
              </button>
            </div>

            {/* Help Link */}
            <div className="pt-4 border-t border-gray-200 text-center">
              <p className="text-xs text-gray-500 mb-2">
                Need help?
              </p>
              <div className="flex justify-center gap-2 text-xs">
                <a
                  href="https://docs.oblien.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-black hover:text-gray-700 font-semibold transition-colors"
                >
                  Documentation
                </a>
                <span className="text-gray-400">·</span>
                <a
                  href="mailto:support@oblien.com"
                  className="text-black hover:text-gray-700 font-semibold transition-colors"
                >
                  Support
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
