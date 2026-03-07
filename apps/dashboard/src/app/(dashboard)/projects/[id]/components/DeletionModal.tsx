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
      <div className="bg-white border border-black/10 rounded-xl p-6 max-w-md w-full shadow-xl">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-amber-50 rounded-lg mr-3 border border-amber-200">
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          </div>
          <h3 className="text-lg font-semibold text-black">Delete Project</h3>
        </div>
        
        <div className="mb-6 space-y-3">
          <p className="text-black/70">
            You are about to delete the project <strong className="text-black">{projectName}</strong> permanently.
          </p>
          
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="text-sm text-amber-900 font-medium mb-1">Important Warning</p>
            <p className="text-sm text-amber-800">
              If you apply this, the entire project <strong>will be deleted</strong> and all associated data on our servers including backups <strong>will be lost permanently</strong>. Make sure this is what you intend.
            </p>
          </div>

          <p className="text-sm text-black/60">
            Type <strong className="text-black bg-black/5 px-1 rounded">{projectName}</strong> to confirm this action.
          </p>
        </div>

        <div className="mb-6">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={`Type "${projectName}" to confirm`}
            className="w-full px-4 py-2.5 bg-black/5 text-black border border-black/10 rounded-lg text-sm focus:border-black focus:ring-2 focus:ring-black/10 outline-none transition-all"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-5 py-2.5 bg-white text-black hover:bg-black/5 border border-black/10 rounded-full font-normal text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className={`px-5 py-2.5 rounded-full font-normal text-sm transition-all ${
              isConfirmDisabled
                ? 'bg-black/20 text-black/40 cursor-not-allowed'
                : 'bg-black text-white hover:bg-gray-900'
            }`}
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  );
};

