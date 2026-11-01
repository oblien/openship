import ar from "./audit-locales/ar.json";
import de from "./audit-locales/de.json";
import en from "./audit-locales/en.json";
import es from "./audit-locales/es.json";
import fr from "./audit-locales/fr.json";
import ja from "./audit-locales/ja.json";
import pt from "./audit-locales/pt.json";
import ru from "./audit-locales/ru.json";
import tr from "./audit-locales/tr.json";
import zh from "./audit-locales/zh.json";

/**
 * Localization helper and translations for Audit Log events.
 * Maps event types and descriptions to active locale phrases.
 */

export interface AuditEventCopy {
	action: string;
	label: string;
	description?: string;
	actionWithoutResource?: string;
}

export type AuditDictionary = Record<
	string,
	{
		action: string;
		label: string;
		description?: string;
		actionWithoutResource?: string;
	}
>;

const AUDIT_TRANSLATIONS: Record<string, AuditDictionary> = {
	ru: ru as AuditDictionary,
	de: de as AuditDictionary,
	es: es as AuditDictionary,
	fr: fr as AuditDictionary,
	ja: ja as AuditDictionary,
	pt: pt as AuditDictionary,
	zh: zh as AuditDictionary,
	tr: tr as AuditDictionary,
	ar: ar as AuditDictionary,
	en: en as AuditDictionary,
};

/**
 * Resolves localized action, label and description for an audit event.
 * Priority:
 *   1. Explicit definition in t.settings.audit.events (if passed from settings.json)
 *   2. Comprehensive fallback dictionary in AUDIT_TRANSLATIONS for active locale
 *   3. Default server taxonomy strings (info.action, info.label, info.description)
 */
export function resolveAuditEventCopy(
	eventType: string,
	info: { action: string; label: string; description?: string },
	auditTranslations?: { events?: Record<string, Partial<AuditEventCopy>> },
	locale = "en",
): AuditEventCopy {
	const events = auditTranslations?.events;

	// 1. Lookup in comprehensive AUDIT_TRANSLATIONS for active locale
	const lang = locale.split(/[-_]/)[0]?.toLowerCase() || "en";
	const dict = AUDIT_TRANSLATIONS[lang] || AUDIT_TRANSLATIONS.en;
	const match =
		dict?.[eventType] ||
		dict?.[eventType.replaceAll(".", ":")] ||
		dict?.[eventType.replaceAll(":", ".")] ||
		dict?.[eventType.replace(".", ":")] ||
		dict?.[eventType.replace(":", ".")];

	// 2. Try explicit overrides from settings.json (merging with dict so missing fields like description don't fall back to English)
	const explicit =
		events?.[eventType] ||
		events?.[eventType.replaceAll(".", ":")] ||
		events?.[eventType.replaceAll(":", ".")] ||
		events?.[eventType.replace(".", ":")] ||
		events?.[eventType.replace(":", ".")];

	if (explicit) {
		return {
			action: explicit.action || match?.action || info.action,
			label: explicit.label || match?.label || info.label,
			description:
				explicit.description || match?.description || info.description || "",
			actionWithoutResource:
				explicit.actionWithoutResource || match?.actionWithoutResource,
		};
	}

	if (match) {
		return {
			action: match.action || info.action,
			label: match.label || info.label,
			description: match.description || info.description || "",
			actionWithoutResource: match.actionWithoutResource,
		};
	}

	// 3. Fallback to info
	return {
		action: info.action,
		label: info.label,
		description: info.description || "",
	};
}
