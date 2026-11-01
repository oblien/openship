"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { useI18n } from "@/components/i18n-provider";

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
}: Props) => {
  const { t } = useI18n();
  return (
  <div className="bg-card border border-border rounded-xl mb-6 shadow-sm overflow-hidden">
    <div className="bg-muted/40 p-6 border-b border-border">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-1">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {showEditButton && (
          <div className="flex gap-2">
            {!isEditing ? (
              <button
                onClick={onEdit}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all duration-200 font-medium text-sm"
              >
                <UiIcon name="edit" className="w-4 h-4" />
                {t.projectSettings.settingSection.edit}
              </button>
            ) : (
              <>
                <button
                  onClick={onSave}
                  className="flex items-center gap-2 px-4 py-2 bg-success-solid text-white rounded-lg hover:bg-success-solid/90 transition-all duration-200 font-medium text-sm"
                >
                  <UiIcon name="save" className="w-4 h-4" />
                  {t.projectSettings.settingSection.save}
                </button>
                <button
                  onClick={onCancel}
                  className="flex items-center gap-2 px-4 py-2 bg-muted text-foreground/70 rounded-lg hover:bg-muted/80 transition-all duration-200 font-medium text-sm"
                >
                  <UiIcon name="close" className="w-4 h-4" />
                  {t.projectSettings.settingSection.cancel}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
    <div className="p-6 bg-card">{children}</div>
  </div>
  );
};
