import React, { useState } from "react";
import { Github } from "lucide-react";

interface AddRepositoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
}

const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [repoUrl, setRepoUrl] = useState("");

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (repoUrl.trim()) {
      onSubmit(repoUrl);
      setRepoUrl("");
    }
  };

  const handleClose = () => {
    onClose();
    setRepoUrl("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && repoUrl.trim()) {
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div
        className="absolute inset-0"
        onClick={handleClose}
      />
      <div className="relative bg-white border border-black/10 rounded-xl p-6 max-w-md w-full shadow-xl">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-gray-50 rounded-lg mr-3 border border-gray-200">
            <Github className="h-6 w-6 text-gray-700" />
          </div>
          <h3 className="text-lg font-semibold text-black">Add Repository</h3>
        </div>
        
        <div className="mb-6 space-y-3">
          <p className="text-black/70">
            Enter a <strong className="text-black">GitHub repository URL</strong> to deploy your project to Oblien.
          </p>
          
        </div>

        <div className="mb-6">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://github.com/username/repository"
            autoFocus
            className="w-full px-4 py-2.5 bg-black/5 border border-black/10 rounded-lg text-black text-sm focus:border-black focus:ring-2 focus:ring-black/10 outline-none transition-all"
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
            onClick={handleSubmit}
            disabled={!repoUrl.trim()}
            className={`px-5 py-2.5 rounded-full font-normal text-sm transition-all ${
              !repoUrl.trim()
                ? 'bg-black/20 text-black/40 cursor-not-allowed'
                : 'bg-black text-white hover:bg-gray-900'
            }`}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddRepositoryModal;
