import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
}

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, maxWidth = 'md' }) => {
  if (!isOpen) return null;

  const widthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-[24px] ${widthClasses[maxWidth]} w-full shadow-2xl max-h-[90vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white border-b border-black/5 px-6 py-4 flex items-center justify-between rounded-t-[24px]">
          <h3 className="text-lg font-semibold text-black">{title}</h3>
          <button onClick={onClose} className="text-black/50 hover:text-black transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Modal;

