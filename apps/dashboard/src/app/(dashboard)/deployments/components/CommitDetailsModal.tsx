"use client";

import React, { useState } from "react";
import { X, Github, GitCommit, ExternalLink, User, Calendar } from "lucide-react";
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
          className="bg-card rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden pointer-events-auto animate-in zoom-in-95 duration-200 border border-border/50"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-card border-b border-border/50 px-6 py-5 flex items-center justify-between z-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <GitCommit className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">Commit Details</h2>
                {hasCommitData && (
                  <p className="text-sm text-muted-foreground font-mono">{deployment.commit.hash}</p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full hover:bg-muted flex items-center justify-center transition-colors"
            >
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[calc(85vh-88px)] p-6">
            {hasCommitData ? (
              <div className="space-y-6">
                {/* Commit Message */}
                <div className="bg-primary/5 rounded-2xl p-5 border border-primary/10">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-card flex items-center justify-center flex-shrink-0 shadow-sm border border-border/50">
                      <GitCommit className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold text-foreground mb-2">
                        {deployment.commit.message}
                      </p>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <User className="w-4 h-4" />
                          <span>{deployment.commit.author}</span>
                        </div>
                        <span className="text-muted-foreground/30">•</span>
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
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Project
                    </p>
                    <p className="text-base font-medium text-foreground">
                      {deployment.projectName || 'Unknown Project'}
                    </p>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Domain
                    </p>
                    <p className="text-base font-medium text-foreground truncate">
                      {deployment.domain || 'No domain'}
                    </p>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Status
                    </p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                      deployment.status === 'success' ? 'bg-emerald-500/10 text-emerald-600' :
                      deployment.status === 'failed' ? 'bg-red-500/10 text-red-600' :
                      deployment.status === 'building' ? 'bg-blue-500/10 text-blue-600' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {deployment.status.charAt(0).toUpperCase() + deployment.status.slice(1)}
                    </span>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Environment
                    </p>
                    <p className="text-base font-medium text-foreground">
                      {deployment.environment || 'production'}
                    </p>
                  </div>
                </div>

                {/* Changed Files */}
                {changedFiles && changedFiles.length > 0 && (
                  <div>
                    <h3 className="text-base font-bold text-foreground mb-3 flex items-center gap-2">
                      Changed Files ({changedFiles.length})
                    </h3>
                    <div className="bg-muted/40 rounded-xl border border-border/50 p-4">
                      <div className="space-y-2">
                        {changedFiles.map((file: any, idx: number) => {
                          const fileTypeConfig: Record<string, { bg: string; text: string; label: string }> = {
                            added: { bg: 'bg-emerald-500/10', text: 'text-emerald-600', label: '+ Added' },
                            modified: { bg: 'bg-blue-500/10', text: 'text-blue-600', label: '~ Modified' },
                            removed: { bg: 'bg-red-500/10', text: 'text-red-600', label: '- Removed' },
                          };
                          const typeConfig = fileTypeConfig[file.type] || fileTypeConfig.modified;

                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-3 p-3 bg-card rounded-lg border border-border/50 hover:bg-muted/60 transition-colors"
                            >
                              <FileIcon fileName={file.name} language={file.language} style={{}} />
                              <span className="text-sm text-foreground flex-1 min-w-0 truncate font-mono">
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
                <div className="flex gap-3 pt-4 border-t border-border/50">
                  {commitUrl && (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-foreground text-background rounded-xl font-medium text-sm hover:opacity-90 transition-all"
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
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:opacity-90 transition-all"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Visit Site
                    </a>
                  )}
                </div>
              </div>
            ) : (
              /* Manual Deployment */
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                  <GitCommit className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  Manual Deployment
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
                  This deployment was triggered manually and doesn't have commit information.
                </p>
                <div className="bg-muted/40 rounded-xl border border-border/50 p-4 max-w-md mx-auto">
                  <div className="space-y-3 text-left">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        Deployment ID
                      </p>
                      <code className="text-sm text-foreground font-mono">{deployment.id}</code>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        Created
                      </p>
                      <p className="text-sm text-foreground">{formatDate(deployment.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        Type
                      </p>
                      <p className="text-sm text-foreground capitalize">{deployment.type || 'Manual'}</p>
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

