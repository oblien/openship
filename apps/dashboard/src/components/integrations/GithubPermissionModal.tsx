"use client";

import React, { useState } from "react";
import { X, Lock, Unlock, Check } from "lucide-react";

interface GithubPermissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (scope: "public" | "all") => void;
}

const GithubPermissionModal: React.FC<GithubPermissionModalProps> = ({
  isOpen,
  onClose,
  onConnect,
}) => {
  const [selectedScope, setSelectedScope] = useState<"public" | "all">("public");
  const [isConnecting, setIsConnecting] = useState(false);

  if (!isOpen) return null;

  const handleConnect = async () => {
    setIsConnecting(true);
    await onConnect(selectedScope);
    setIsConnecting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-900 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Connect to GitHub</h2>
              <p className="text-sm text-gray-500">Choose repository access level</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 mb-6">
            Select which repositories Oblien can access. You can change this later in your GitHub settings.
          </p>

          {/* Public Only Option */}
          <button
            onClick={() => setSelectedScope("public")}
            className={`w-full p-4 border-2 rounded-lg text-left transition-all ${
              selectedScope === "public"
                ? "border-gray-900 bg-gray-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  selectedScope === "public"
                    ? "border-gray-900 bg-gray-900"
                    : "border-gray-300"
                }`}>
                  {selectedScope === "public" && <Check className="w-3 h-3 text-white" />}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Unlock className="w-4 h-4 text-gray-700" />
                    <h3 className="font-semibold text-gray-900">Public repositories only</h3>
                  </div>
                  <p className="text-sm text-gray-600">
                    Access to your public repositories. Perfect for open source projects.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    <li>• Read public repository data</li>
                    <li>• Deploy public repositories</li>
                    <li>• Create webhooks for public repos</li>
                  </ul>
                </div>
              </div>
            </div>
          </button>

          {/* All Repositories Option */}
          <button
            onClick={() => setSelectedScope("all")}
            className={`w-full p-4 border-2 rounded-lg text-left transition-all ${
              selectedScope === "all"
                ? "border-gray-900 bg-gray-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  selectedScope === "all"
                    ? "border-gray-900 bg-gray-900"
                    : "border-gray-300"
                }`}>
                  {selectedScope === "all" && <Check className="w-3 h-3 text-white" />}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Lock className="w-4 h-4 text-gray-700" />
                    <h3 className="font-semibold text-gray-900">Public and private repositories</h3>
                  </div>
                  <p className="text-sm text-gray-600">
                    Full access to all your repositories. Required for private projects.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    <li>• Read public and private repository data</li>
                    <li>• Deploy any repository</li>
                    <li>• Create webhooks for all repos</li>
                    <li>• Access organization repositories</li>
                  </ul>
                </div>
              </div>
            </div>
          </button>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
            <p className="text-xs text-blue-900">
              <strong>Note:</strong> You can revoke access at any time from your GitHub settings under Applications → Authorized OAuth Apps.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            disabled={isConnecting}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            className="px-6 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isConnecting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Connecting...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                Connect to GitHub
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GithubPermissionModal;

