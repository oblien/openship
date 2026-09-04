"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

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
  const { t } = useI18n();
  if (!isOpen) return null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50"
    >
      <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full shadow-2xl">
        <div className="flex items-center mb-4">
          <div className="p-2 bg-danger-bg rounded-lg me-3 border border-danger-border">
            <AlertTriangle className="h-6 w-6 text-danger" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">{t.projectSettings.deleteDialog.title}</h3>
        </div>
        <p className="text-muted-foreground mb-6">
          {t.projectSettings.deleteDialog.bodyPrefix}
          <strong className="text-foreground">{projectName}</strong>
          {t.projectSettings.deleteDialog.bodySuffix}
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-muted text-foreground hover:bg-muted/80 transition-colors"
          >
            {t.projectSettings.deleteDialog.cancel}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
          >
            {t.projectSettings.deleteDialog.delete}
          </button>
        </div>
      </div>
    </div>
  );
};
