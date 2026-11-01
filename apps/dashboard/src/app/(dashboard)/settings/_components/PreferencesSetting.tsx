"use client";

/**
 * Settings → General → Preferences. Personal, per-browser display preferences
 * (nothing sent to the server). Collapsed by default. Currently holds Demo mode
 * (blur IPs, hosts and env values for screen-shares); add future toggles as rows.
 */

import type { ReactNode } from "react";
import { SettingsSection } from "./SettingsSection";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { useDemoMode, setDemoMode } from "@/lib/demo-mode";
import { useI18n } from "@/components/i18n-provider";

export function PreferencesSetting() {
	const { t } = useI18n();
	const demoMode = useDemoMode();

	return (
		<SettingsSection
			icon={"sliders"}
			title={t.settings.preferences.title}
			description={t.settings.preferences.description}
			collapsible
		>
			<div className="space-y-3">
				<PreferenceRow
					title={t.settings.preferences.demoMode.title}
					hint={t.settings.preferences.demoMode.description}
					checked={demoMode}
					onChange={setDemoMode}
				/>
			</div>
		</SettingsSection>
	);
}

function PreferenceRow({
	title,
	hint,
	checked,
	onChange,
}: {
	title: string;
	hint: ReactNode;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/10 p-4">
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">{title}</p>
				<p className="text-xs text-muted-foreground">{hint}</p>
			</div>
			<Toggle checked={checked} onChange={onChange} aria-label={title} />
		</div>
	);
}
