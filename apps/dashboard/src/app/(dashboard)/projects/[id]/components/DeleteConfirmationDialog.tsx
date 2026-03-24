import React from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  projectName: string;
}

export const DeleteConfirmationDialog = ({
  isOpen,
  onClose,
  onConfirm,
  projectName,
}: Props) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full shadow-2xl">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-red-500/10 rounded-lg mr-3 border border-red-500/20">
            <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">Delete Project</h3>
        </div>
        <p className="text-muted-foreground mb-6">
          Are you sure you want to delete{" "}
          <strong className="text-foreground">{projectName}</strong>? This action
          cannot be undone and will permanently delete all project data,
          deployments, and settings.
        </p>
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-muted text-foreground hover:bg-muted/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
          >
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
};
