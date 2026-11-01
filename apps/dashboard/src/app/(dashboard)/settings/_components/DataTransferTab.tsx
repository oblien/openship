"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/** Archive export/import lives under recovery. Active controller relocation
 * uses the shared Instance location flow, not a second database-copy wizard. */

import { useState } from "react";

import { SettingsSection } from "./SettingsSection";
import { ExportPanel } from "@/components/data-transfer/ExportPanel";
import { ImportModal as DataTransferImportModal } from "@/components/data-transfer/ImportModal";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

export function DataTransferTab() {
	const { user } = useAuth();
	const { showToast } = useToast();
	const { t } = useI18n();
	if (user?.role !== "admin") return null;

	return (
		<SettingsSection
			icon="archive"
			title={t.settings.dataTransfer.backupTitle}
			description={t.settings.dataTransfer.backupDesc}
			collapsible
		>
			<div className="space-y-4">
				<div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-xs leading-relaxed text-warning">
					{t.settings.dataTransfer.backupWarning}
				</div>
				<ExportCard onToast={showToast} />
				<ImportCard onToast={showToast} />
			</div>
		</SettingsSection>
	);
}

type Toast = (
	message: string,
	type: "success" | "error",
	title?: string,
) => void;

/* ── Export ──────────────────────────────────────────────────────── */

function ExportCard(_props: { onToast: Toast }) {
	const { t } = useI18n();
	return (
		<SettingsSection
			icon={"download"}
			title={t.settings.dataTransfer.exportInstanceTitle}
			description={t.settings.dataTransfer.exportInstanceDesc}
		>
			<ExportPanel />
		</SettingsSection>
	);
}

function ImportCard({ onToast }: { onToast: Toast }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);

	return (
		<SettingsSection
			icon={"upload"}
			title={t.settings.dataTransfer.import.title}
			description={t.settings.dataTransfer.import.description}
			iconBg="bg-primary/10"
			iconColor="text-primary"
		>
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground leading-relaxed">
					{t.settings.dataTransfer.import.intro}
				</p>
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
				>
					<UiIcon name="upload" className="size-4" />
					{t.settings.dataTransfer.import.importFromFile}
				</button>
			</div>

			<ImportModal
				open={open}
				onClose={() => setOpen(false)}
				onToast={onToast}
			/>
		</SettingsSection>
	);
}

function ImportModal({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
	onToast: Toast;
}) {
	return open ? (
		<DataTransferImportModal open={open} onClose={onClose} />
	) : null;
}
