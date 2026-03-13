"use client";

import React, { useState, useRef, useEffect } from "react";
import { MoreVertical, ExternalLink, Copy, RotateCcw, XCircle, Trash2 } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { deployApi } from "@/lib/api";

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
  onStatusChange?: () => void;
}

export const DeploymentMenu: React.FC<DeploymentMenuProps> = ({
  deployment,
  triggerClassName,
  onStatusChange,
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

  const isActive = ["pending", "queued", "building", "deploying"].includes(deployment.status);

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.cancel(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.deleteDeployment(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={triggerClassName || "w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-10 w-56 bg-popover rounded-xl shadow-lg border border-border/50 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          {deployment.domain && (
            <button
              onClick={() => {
                window.open(`https://${deployment.domain}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <ExternalLink className="w-4 h-4" />
              Open Deployment
            </button>
          )}

          {deployment.owner && deployment.repo && (
            <button
              onClick={() => {
                window.open(`https://github.com/${deployment.owner}/${deployment.repo}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 16, 'currentColor', {}, true)}
              View Repository
            </button>
          )}

          <div className="h-px bg-border/50 my-2" />

          {deployment.domain && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(`https://${deployment.domain}`);
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <Copy className="w-4 h-4" />
              Copy Domain URL
            </button>
          )}

          <button
            onClick={() => {
              navigator.clipboard.writeText(deployment.id);
              setIsOpen(false);
            }}
            className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
          >
            <Copy className="w-4 h-4" />
            Copy Build ID
          </button>

          {isActive && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleCancel}
                className="w-full px-4 py-2.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-3"
              >
                <XCircle className="w-4 h-4" />
                Cancel Deployment
              </button>
            </>
          )}

          {!isActive && deployment.status !== "building" && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={() => setIsOpen(false)}
                className="w-full px-4 py-2.5 text-left text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
              >
                <RotateCcw className="w-4 h-4" />
                Redeploy
              </button>
            </>
          )}

          {!isActive && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleDelete}
                className="w-full px-4 py-2.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-3"
              >
                <Trash2 className="w-4 h-4" />
                Delete Deployment
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

