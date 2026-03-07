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
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6 max-w-md w-full">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-red-950/20 rounded-lg mr-3">
            <AlertTriangle className="h-6 w-6 text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-white">Delete Project</h3>
        </div>
        <p className="text-zinc-400 mb-6">
          Are you sure you want to delete{" "}
          <strong className="text-white">{projectName}</strong>? This action
          cannot be undone and will permanently delete all project data,
          deployments, and settings.
        </p>
        <div className="flex justify-end space-x-3">
          <button onClick={onClose}>
            Cancel
          </button>
          <button onClick={onConfirm}>
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
};
