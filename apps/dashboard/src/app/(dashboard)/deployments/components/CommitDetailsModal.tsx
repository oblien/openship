"use client";

import React, { useState } from "react";
import { X, Github, GitCommit, ExternalLink, User, Calendar } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { formatDate } from "@/utils/date";
import FileIcon from "@/components/ui/FileIcon";
import type { Deployment } from "../types";

interface CommitDetailsModalProps {
  deployment: Deployment;
  isOpen: boolean;
  onClose: () => void;
}

export const CommitDetailsModal: React.FC<CommitDetailsModalProps> = ({
  deployment,
  isOpen,
  onClose,
}) => {
  const [expandedSection, setExpandedSection] = useState<'added' | 'modified' | 'removed' | null>('modified');

  if (!isOpen) return null;

  const hasCommitData = deployment.commit && deployment.commit.hash && deployment.commit.hash !== 'N/A';
  const commitUrl = deployment.owner && deployment.repo && deployment.commit?.hash
    ? `https://github.com/${deployment.owner}/${deployment.repo}/commit/${deployment.commit.hash}`
    : null;

  // Parse changed files from commit message if available
  // This would ideally come from the API with the full commit data
  const changedFiles = deployment.commit?.changedFiles || [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-[25px] shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden pointer-events-auto animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-black/10 px-6 py-5 flex items-center justify-between z-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                <GitCommit className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-black">Commit Details</h2>
                {hasCommitData && (
                  <p className="text-sm text-black/50 font-mono">{deployment.commit.hash}</p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full hover:bg-black/5 flex items-center justify-center transition-colors"
            >
              <X className="w-5 h-5 text-black/60" />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[calc(85vh-88px)] p-6">
            {hasCommitData ? (
              <div className="space-y-6">
                {/* Commit Message */}
                <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-5 border border-indigo-100">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center flex-shrink-0 shadow-sm">
                      {generateIcon('commit%20git-24-1658431404.png', 20, 'rgb(79, 70, 229)')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold text-black mb-2">
                        {deployment.commit.message}
                      </p>
                      <div className="flex items-center gap-3 text-sm text-black/60">
                        <div className="flex items-center gap-1.5">
                          <User className="w-4 h-4" />
                          <span>{deployment.commit.author}</span>
                        </div>
                        <span className="text-black/30">•</span>
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-4 h-4" />
                          <span>{formatDate(deployment.commit.timestamp, undefined, undefined, true)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Deployment Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white border border-black/10 rounded-xl p-4">
                    <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-2">
                      Project
                    </p>
                    <p className="text-base font-medium text-black">
                      {deployment.projectName || 'Unknown Project'}
                    </p>
                  </div>
                  <div className="bg-white border border-black/10 rounded-xl p-4">
                    <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-2">
                      Domain
                    </p>
                    <p className="text-base font-medium text-black truncate">
                      {deployment.domain || 'No domain'}
                    </p>
                  </div>
                  <div className="bg-white border border-black/10 rounded-xl p-4">
                    <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-2">
                      Status
                    </p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                      deployment.status === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                      deployment.status === 'failed' ? 'bg-red-50 text-red-700 border border-red-200' :
                      deployment.status === 'building' ? 'bg-blue-50 text-blue-700 border border-blue-200' :
                      'bg-gray-50 text-gray-700 border border-gray-200'
                    }`}>
                      {deployment.status.charAt(0).toUpperCase() + deployment.status.slice(1)}
                    </span>
                  </div>
                  <div className="bg-white border border-black/10 rounded-xl p-4">
                    <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-2">
                      Environment
                    </p>
                    <p className="text-base font-medium text-black">
                      {deployment.environment || 'production'}
                    </p>
                  </div>
                </div>

                {/* Changed Files */}
                {changedFiles && changedFiles.length > 0 && (
                  <div>
                    <h3 className="text-base font-bold text-black mb-3 flex items-center gap-2">
                      {generateIcon('document%20zip-76-1662364367.png', 20, 'black')}
                      Changed Files ({changedFiles.length})
                    </h3>
                    <div className="bg-gray-50 rounded-xl border border-black/10 p-4">
                      <div className="space-y-2">
                        {changedFiles.map((file: any, idx: number) => {
                          const fileTypeConfig: Record<string, { bg: string; text: string; label: string }> = {
                            added: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: '+ Added' },
                            modified: { bg: 'bg-blue-50', text: 'text-blue-700', label: '~ Modified' },
                            removed: { bg: 'bg-red-50', text: 'text-red-700', label: '- Removed' },
                          };
                          const typeConfig = fileTypeConfig[file.type] || fileTypeConfig.modified;

                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-3 p-3 bg-white rounded-lg border border-black/5 hover:border-black/10 transition-colors"
                            >
                              <FileIcon fileName={file.name} language={file.language} style={{}} />
                              <span className="text-sm text-black flex-1 min-w-0 truncate font-mono">
                                {file.name}
                              </span>
                              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${typeConfig.bg} ${typeConfig.text}`}>
                                {typeConfig.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-4 border-t border-black/10">
                  {commitUrl && (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-black text-white rounded-full font-medium text-sm hover:bg-gray-900 transition-all"
                    >
                      <Github className="w-4 h-4" />
                      View on GitHub
                    </a>
                  )}
                  {deployment.domain && deployment.status === 'success' && (
                    <a
                      href={`https://${deployment.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-indigo-600 text-white rounded-full font-medium text-sm hover:bg-indigo-700 transition-all"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Visit Site
                    </a>
                  )}
                </div>
              </div>
            ) : (
              // Manual Deployment
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
                  {generateIcon('tools-118-1658432731.png', 32, 'rgba(0,0,0,0.3)')}
                </div>
                <h3 className="text-lg font-semibold text-black mb-2">
                  Manual Deployment
                </h3>
                <p className="text-sm text-black/50 max-w-md mx-auto mb-6">
                  This deployment was triggered manually and doesn't have commit information.
                </p>
                <div className="bg-gray-50 rounded-xl border border-black/10 p-4 max-w-md mx-auto">
                  <div className="space-y-3 text-left">
                    <div>
                      <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-1">
                        Deployment ID
                      </p>
                      <code className="text-sm text-black font-mono">{deployment.id}</code>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-1">
                        Created
                      </p>
                      <p className="text-sm text-black">{formatDate(deployment.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-black/50 uppercase tracking-wide mb-1">
                        Type
                      </p>
                      <p className="text-sm text-black capitalize">{deployment.type || 'Manual'}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

