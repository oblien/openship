"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState } from "react";
import { useI18n } from "@/components/i18n-provider";

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
  const { t } = useI18n();
  const w = t.widgets.integrations.githubPermission;
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
              <UiIcon name="github" className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{w.title}</h2>
              <p className="text-sm text-gray-500">{w.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <UiIcon name="close" className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 mb-6">
            {w.intro}
          </p>

          {/* Public Only Option */}
          <button
            onClick={() => setSelectedScope("public")}
            className={`w-full p-4 border-2 rounded-lg text-start transition-all ${
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
                  {selectedScope === "public" && <UiIcon name="check" className="w-3 h-3 text-white" />}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <UiIcon name="unlock" className="w-4 h-4 text-gray-700" />
                    <h3 className="font-semibold text-gray-900">{w.publicTitle}</h3>
                  </div>
                  <p className="text-sm text-gray-600">
                    {w.publicDesc}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    <li>• {w.publicItem1}</li>
                    <li>• {w.publicItem2}</li>
                    <li>• {w.publicItem3}</li>
                  </ul>
                </div>
              </div>
            </div>
          </button>

          {/* All Repositories Option */}
          <button
            onClick={() => setSelectedScope("all")}
            className={`w-full p-4 border-2 rounded-lg text-start transition-all ${
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
                  {selectedScope === "all" && <UiIcon name="check" className="w-3 h-3 text-white" />}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <UiIcon name="lock" className="w-4 h-4 text-gray-700" />
                    <h3 className="font-semibold text-gray-900">{w.allTitle}</h3>
                  </div>
                  <p className="text-sm text-gray-600">
                    {w.allDesc}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    <li>• {w.allItem1}</li>
                    <li>• {w.allItem2}</li>
                    <li>• {w.allItem3}</li>
                    <li>• {w.allItem4}</li>
                  </ul>
                </div>
              </div>
            </div>
          </button>

          <div className="bg-info-bg border border-info-border rounded-lg p-4 mt-4">
            <p className="text-xs text-info">
              <strong>{w.noteLabel}</strong> {w.noteText}
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
            {w.cancel}
          </button>
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            className="px-6 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isConnecting ? (
              <>
                <UiIcon name="spinner" className="animate-spin h-4 w-4 text-white" />
                {w.connecting}
              </>
            ) : (
              <>
                <UiIcon name="github" className="w-4 h-4" />
                {w.connect}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GithubPermissionModal;

