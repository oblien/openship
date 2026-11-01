import { describe, expect, it } from "vitest";
import {
  localizeDiagnosisMessage,
  localizeIssueMessage,
  localizeIssueTitle,
  localizeActionLabel,
} from "./localize-issues";
import ruIssues from "@/i18n/locales/ru/issues.json";
import enIssues from "@/i18n/locales/en/issues.json";

describe("localizeDiagnosisMessage", () => {
  const ruMsgs = ruIssues.messages;
  const enMsgs = enIssues.messages;

  it("localizes DNS A record unresolved message into Russian and preserves Detail", () => {
    const raw =
      "app.sently.ru: app.sently.ru doesn't resolve to this server yet — the DNS A record is missing or hasn't propagated. Wait for propagation, then retry from the Domains tab. — Detail: DNS problem: NXDOMAIN looking up A for app.sently.ru";

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain("app.sently.ru ещё не указывает на этот сервер");
    expect(resultRu).toContain("A-запись DNS отсутствует");
    expect(resultRu).toContain(
      "Detail: DNS problem: NXDOMAIN looking up A for app.sently.ru",
    );
    // Should NOT have redundant leading prefix
    expect(resultRu).not.toMatch(/^app\.sently\.ru:\s+app\.sently\.ru/);

    const resultEn = localizeDiagnosisMessage(raw, enMsgs);
    expect(resultEn).toContain(
      "app.sently.ru doesn't resolve to this server yet",
    );
    expect(resultEn).toContain("Detail: DNS problem: NXDOMAIN");
  });

  it("localizes Port 80 unreachable error", () => {
    const raw =
      "Port 80 for api.example.com isn't reachable from the internet — a firewall / cloud security group is blocking it, the domain doesn't point at this server, or another proxy is still bound to :80.";

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain(
      "Порт 80 для api.example.com недоступен из интернета",
    );
    expect(resultRu).toContain("фаервол");
  });

  it("localizes Cloudflare proxy conflict error", () => {
    const raw =
      'Cloudflare\'s proxy is answering the certificate challenge for app.example.xyz instead of forwarding it to this server: it redirects the request to HTTPS, then rejects the origin\'s TLS. Fix it one of three ways — set SSL/TLS → Overview to "Full" (not "Full (strict)") until the first certificate is issued, or turn the orange cloud off for this record until it is, or upload a Cloudflare Origin CA certificate from the Domains tab and skip Let\'s Encrypt entirely.';

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain(
      "Прокси Cloudflare отвечает на проверку сертификата для app.example.xyz",
    );
    expect(resultRu).toContain("перенаправляет запрос на HTTPS");
  });

  it("localizes Redirect 404 error", () => {
    const raw =
      'The challenge for test.com was redirected from HTTP to HTTPS and then answered with a 404 — so whatever served it isn\'t routing that hostname. If test.com is behind Cloudflare, its "Always Use HTTPS" is doing the redirect: set SSL/TLS → Overview to "Full" (not "Full (strict)") until the first certificate is issued, or turn the orange cloud off for this record. Otherwise check the A record points at this server and the domain is registered here. Nothing is occupying :80, so take-over / migrate will not help.';

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain(
      "Проверка для test.com была перенаправлена с HTTP на HTTPS и вернула ошибку 404",
    );
  });

  it("localizes Port 80 not ACME error", () => {
    const raw =
      "Port 80 answered but not with our ACME challenge — another web server is still serving :80, so the takeover didn't complete. Re-run and choose take-over / migrate.";

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain("Порт 80 ответил, но не проверкой ACME");
  });

  it("localizes Rate limit error", () => {
    const raw =
      "Let's Encrypt rate limit reached for mydomain.org — wait before retrying.";

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain(
      "Достигнут лимит запросов Let's Encrypt для mydomain.org",
    );
  });

  it("localizes Port bind collision error", () => {
    const raw =
      "Couldn't start the certificate challenge listener for sub.domain.com on port 49180: something on this server is already holding it. That port is used only while a certificate is being issued, so this is almost always a certificate run from an earlier attempt that hasn't exited — retry, and if it persists find the holder with `ss -ltnp | grep 49180` and stop it. Nothing was requested from Let's Encrypt, so this is not a DNS or routing problem.";

    const resultRu = localizeDiagnosisMessage(raw, ruMsgs);
    expect(resultRu).toContain(
      "Не удалось запустить слушатель проверки сертификата для sub.domain.com на порту 49180",
    );
  });

  it("localizes common network and timeout errors", () => {
    expect(
      localizeDiagnosisMessage(
        "Request timed out. The server took too long to respond.",
        ruMsgs,
      ),
    ).toBe("Превышено время ожидания ответа. Сервер отвечал слишком долго.");

    expect(localizeDiagnosisMessage("Request cancelled.", ruMsgs)).toBe(
      "Запрос отменён.",
    );
    expect(localizeDiagnosisMessage("Host is not reachable", ruMsgs)).toBe(
      "Хост недоступен",
    );
    expect(localizeDiagnosisMessage("SSH connection refused", ruMsgs)).toBe(
      "В соединении SSH отказано",
    );
  });

  it("passes unrecognized error messages through untouched", () => {
    const custom = "Custom unexpected runtime exception 0x8823";
    expect(localizeDiagnosisMessage(custom, ruMsgs)).toBe(custom);
    expect(localizeDiagnosisMessage(null, ruMsgs)).toBe("");
    expect(localizeDiagnosisMessage(undefined, ruMsgs)).toBe("");
  });
});

describe("localizeIssueMessage integrates diagnosis messages", () => {
  it("translates both standard issues and diagnosis messages", () => {
    const standard =
      "The deploy succeeded but its edge route didn't sync, so the public URL may not resolve yet. Retrying re-runs just the routing step — it does not rebuild.";
    expect(localizeIssueMessage(standard, ruIssues.messages)).toContain(
      "Деплой завершился успешно, но маршрут edge-прокси не синхронизировался",
    );

    const diagnosis =
      "app.example.com doesn't resolve to this server yet — the DNS A record is missing or hasn't propagated. Wait for propagation, then retry from the Domains tab.";
    expect(localizeIssueMessage(diagnosis, ruIssues.messages)).toContain(
      "app.example.com ещё не указывает на этот сервер",
    );
  });
});
