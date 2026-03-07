"use client";

import React, { useState, useRef, useEffect } from "react";
import { MoreVertical, ExternalLink, Copy, Download, RotateCcw, Trash2, Eye } from "lucide-react";
import { generateIcon } from "@/utils/icons";

interface Deployment {
  id: string;
  status: string;
  domain: string;
  owner?: string;
  repo?: string;
  commit: {
    hash: string;
  };
}

interface DeploymentMenuProps {
  deployment: Deployment;
  triggerClassName?: string;
}

export const DeploymentMenu: React.FC<DeploymentMenuProps> = ({
  deployment,
  triggerClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleOpenDomain = () => {
    if (deployment.domain) {
      window.open(`https://${deployment.domain}`, "_blank");
    }
    setIsOpen(false);
  };

  const handleOpenGithub = () => {
    if (deployment.owner && deployment.repo) {
      window.open(`https://github.com/${deployment.owner}/${deployment.repo}`, "_blank");
    }
    setIsOpen(false);
  };

  const handleCopyDomain = () => {
    if (deployment.domain) {
      navigator.clipboard.writeText(`https://${deployment.domain}`);
      // You can add a toast notification here
    }
    setIsOpen(false);
  };

  const handleCopydeployment_session_id = () => {
    navigator.clipboard.writeText(deployment.id);
    // You can add a toast notification here
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={triggerClassName || "w-10 h-10 rounded-full bg-white flex items-center justify-center border border-black/10 hover:bg-black/5 transition-colors"}
      >
        <MoreVertical className="w-4 h-4 text-black/60" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-12 w-56 bg-white rounded-xl shadow-lg border border-black/10 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          {/* View Domain */}
          {deployment.domain && (
            <button
              onClick={handleOpenDomain}
              className="w-full px-4 py-2.5 text-left text-sm text-black/70 hover:bg-black/5 transition-colors flex items-center gap-3"
            >
              <ExternalLink className="w-4 h-4" />
              Open Deployment
            </button>
          )}

          {/* View on GitHub */}
          {deployment.owner && deployment.repo && (
            <button
              onClick={handleOpenGithub}
              className="w-full px-4 py-2.5 text-left text-sm text-black/70 hover:bg-black/5 transition-colors flex items-center gap-3"
            >
              {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 16, 'rgb(0, 0, 0, 0.7)', {}, true)}
              View Repository
            </button>
          )}

          <div className="h-px bg-black/5 my-2" />

          {/* Copy Domain */}
          {deployment.domain && (
            <button
              onClick={handleCopyDomain}
              className="w-full px-4 py-2.5 text-left text-sm text-black/70 hover:bg-black/5 transition-colors flex items-center gap-3"
            >
              <Copy className="w-4 h-4" />
              Copy Domain URL
            </button>
          )}

          {/* Copy Build ID */}
          <button
            onClick={handleCopydeployment_session_id}
            className="w-full px-4 py-2.5 text-left text-sm text-black/70 hover:bg-black/5 transition-colors flex items-center gap-3"
          >
            <Copy className="w-4 h-4" />
            Copy Build ID
          </button>

          {/* Redeploy - Only if not building */}
          {deployment.status !== 'building' && (
            <>
              <div className="h-px bg-black/5 my-2" />
              <button
                onClick={() => setIsOpen(false)}
                className="w-full px-4 py-2.5 text-left text-sm text-black/70 hover:bg-black/5 transition-colors flex items-center gap-3"
              >
                <RotateCcw className="w-4 h-4" />
                Redeploy
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

