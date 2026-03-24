import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  projectName: string;
}

export const DeletionModal = ({
  isOpen,
  onClose,
  onConfirm,
  projectName,
}: Props) => {
  const [inputValue, setInputValue] = useState("");
  const isConfirmDisabled = inputValue !== projectName;

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (!isConfirmDisabled) {
      onConfirm();
      setInputValue("");
      onClose();
    }
  };

  const handleClose = () => {
    setInputValue("");
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full shadow-xl">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-amber-500/10 rounded-lg mr-3 border border-amber-500/20">
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">Delete Project</h3>
        </div>
        
        <div className="mb-6 space-y-3">
          <p className="text-muted-foreground">
            You are about to delete the project <strong className="text-foreground">{projectName}</strong> permanently.
          </p>
          
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
            <p className="text-sm text-amber-700 dark:text-amber-300 font-medium mb-1">Important Warning</p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              If you apply this, the entire project <strong>will be deleted</strong> and all associated data on our servers including backups <strong>will be lost permanently</strong>. Make sure this is what you intend.
            </p>
          </div>

          <p className="text-sm text-muted-foreground">
            Type <strong className="text-foreground bg-muted/60 px-1 rounded">{projectName}</strong> to confirm this action.
          </p>
        </div>

        <div className="mb-6">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={`Type "${projectName}" to confirm`}
            className="w-full px-4 py-2.5 bg-muted/60 text-foreground border border-border rounded-lg text-sm focus:border-primary/30 focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-5 py-2.5 bg-card text-foreground hover:bg-muted/60 border border-border rounded-full font-normal text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className={`px-5 py-2.5 rounded-full font-normal text-sm transition-all ${
              isConfirmDisabled
                ? 'bg-muted text-muted-foreground/70 cursor-not-allowed'
                : 'bg-foreground text-background hover:bg-foreground/90'
            }`}
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  );
};

