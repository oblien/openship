import React from "react";
import { Edit2, Save, X } from "lucide-react";

interface Props {
  title: string;
  description?: string;
  children: React.ReactNode;
  isEditing?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onCancel?: () => void;
  showEditButton?: boolean;
}

export const SettingSection = ({ 
  title, 
  description, 
  children, 
  isEditing = false,
  onEdit,
  onSave,
  onCancel,
  showEditButton = false
}: Props) => (
  <div className="bg-white border border-gray-200 rounded-xl mb-6 shadow-sm overflow-hidden">
    <div className="bg-gradient-to-r from-gray-50 to-white p-6 border-b border-gray-200">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-black mb-1">{title}</h3>
          {description && <p className="text-sm text-gray-600">{description}</p>}
        </div>
        {showEditButton && (
          <div className="flex gap-2">
            {!isEditing ? (
              <button
                onClick={onEdit}
                className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-all duration-200 font-medium text-sm"
              >
                <Edit2 className="w-4 h-4" />
                Edit
              </button>
            ) : (
              <>
                <button
                  onClick={onSave}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-all duration-200 font-medium text-sm"
                >
                  <Save className="w-4 h-4" />
                  Save
                </button>
                <button
                  onClick={onCancel}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-all duration-200 font-medium text-sm"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
    <div className="p-6 bg-white">{children}</div>
  </div>
);
