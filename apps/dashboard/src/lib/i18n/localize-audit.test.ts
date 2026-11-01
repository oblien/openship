import { describe, expect, it } from "vitest";
import { resolveAuditEventCopy } from "./localize-audit";

describe("resolveAuditEventCopy", () => {
	it("localizes project.deletion.failed into Russian", () => {
		const info = {
			action: "failed to delete",
			label: "App deletion failed",
			description:
				"Cleanup did not complete, so the app record was kept for a safe retry.",
		};

		const copy = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"ru",
		);
		expect(copy.action).toBe("не смог удалить");
		expect(copy.label).toBe("Ошибка удаления приложения");
		expect(copy.description).toBe(
			"Очистка не завершилась, поэтому запись приложения сохранена для безопасного повтора.",
		);
	});

	it("localizes deployment.failed and other taxonomy descriptions", () => {
		const info = {
			action: "failed to deploy",
			label: "Deploy failed",
			description: "A deployment errored out before reaching a healthy state.",
		};

		const ru = resolveAuditEventCopy(
			"deployment.failed",
			info,
			undefined,
			"ru",
		);
		expect(ru.label).toBe("Ошибка деплоя");
		expect(ru.action).toBe("сбой при деплое");
		expect(ru.description).toBe(
			"Деплой завершился сбоем до перехода в рабочее состояние.",
		);

		const de = resolveAuditEventCopy(
			"deployment.failed",
			info,
			undefined,
			"de",
		);
		expect(de.label).toBe("Deployment fehlgeschlagen");
		expect(de.description).toBe(
			"Ein Deployment ist vor Erreichen eines fehlerfreien Zustands fehlgeschlagen.",
		);

		const es = resolveAuditEventCopy(
			"deployment.failed",
			info,
			undefined,
			"es",
		);
		expect(es.label).toBe("Despliegue fallido");
		expect(es.description).toBe(
			"Un despliegue falló antes de alcanzar un estado saludable.",
		);
	});

	it("localizes project.updated into Russian", () => {
		const info = {
			action: "updated",
			label: "App updated",
			description:
				"Settings, services, environment variables, or routing were changed.",
		};

		const copy = resolveAuditEventCopy(
			"project.updated",
			info,
			undefined,
			"ru",
		);
		expect(copy.action).toBe("обновил");
		expect(copy.label).toBe("Приложение обновлено");
		expect(copy.description).toBe(
			"Настройки, сервисы, переменные окружения или маршрутизация были изменены.",
		);
	});

	it("localizes project.deletion.rejected into Russian", () => {
		const info = {
			action: "tried to delete",
			label: "App deletion refused",
			description:
				"A delete was refused — something still depends on this app.",
		};

		const copy = resolveAuditEventCopy(
			"project.deletion.rejected",
			info,
			undefined,
			"ru",
		);
		expect(copy.action).toBe("попытался удалить");
		expect(copy.label).toBe("В удалении приложения отказано");
		expect(copy.description).toBe(
			"В удалении отказано — другие ресурсы всё ещё зависят от этого приложения.",
		);
	});

	it("localizes service incidents into Russian", () => {
		const down = resolveAuditEventCopy(
			"service.down",
			{ action: "reported down", label: "App went down" },
			undefined,
			"ru",
		);
		expect(down.label).toBe("Приложение остановлено");
		expect(down.action).toBe("сообщил об остановке приложения");

		const crash = resolveAuditEventCopy(
			"service.crash_loop",
			{ action: "reported crash looping", label: "App is crash looping" },
			undefined,
			"ru",
		);
		expect(crash.label).toBe("Приложение постоянно падает (CrashLoop)");

		const recovered = resolveAuditEventCopy(
			"service.recovered",
			{ action: "reported recovered", label: "App recovered" },
			undefined,
			"ru",
		);
		expect(recovered.label).toBe("Приложение восстановилось");
	});

	it("localizes across other supported languages", () => {
		const info = {
			action: "failed to delete",
			label: "App deletion failed",
			description:
				"Cleanup did not complete, so the app record was kept for a safe retry.",
		};

		const de = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"de",
		);
		expect(de.label).toBe("App-Löschung fehlgeschlagen");
		expect(de.action).toBe("konnte nicht löschen");

		const fr = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"fr",
		);
		expect(fr.label).toBe("Échec de la suppression de l'application");
		expect(fr.action).toBe("n'a pas pu supprimer");

		const es = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"es",
		);
		expect(es.label).toBe("Error al eliminar la app");
		expect(es.action).toBe("no pudo eliminar");

		const ja = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"ja",
		);
		expect(ja.label).toBe("アプリ削除の失敗");

		const zh = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"zh",
		);
		expect(zh.label).toBe("删除应用失败");

		const ar = resolveAuditEventCopy(
			"project.deletion.failed",
			info,
			undefined,
			"ar",
		);
		expect(ar.label).toBe("فشل حذف التطبيق");
	});

	it("prefers explicit overrides from settings if provided", () => {
		const info = {
			action: "updated",
			label: "App updated",
		};

		const override = {
			events: {
				"project.updated": {
					action: "кастомно обновил",
					label: "Кастомный заголовок",
				},
			},
		};

		const copy = resolveAuditEventCopy("project.updated", info, override, "ru");
		expect(copy.action).toBe("кастомно обновил");
		expect(copy.label).toBe("Кастомный заголовок");
	});

	it("falls back to server copy for unknown event types", () => {
		const custom = {
			action: "custom action",
			label: "Custom label",
			description: "Custom description",
		};

		const copy = resolveAuditEventCopy(
			"unknown.event.type",
			custom,
			undefined,
			"ru",
		);
		expect(copy.action).toBe("custom action");
		expect(copy.label).toBe("Custom label");
		expect(copy.description).toBe("Custom description");
	});
});
