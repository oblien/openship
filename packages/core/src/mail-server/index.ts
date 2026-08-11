/**
 * Mail-server primitives - pure module.
 *
 * Houses self-hosted mail-server modeling that doesn't need I/O. Today:
 * routing topology (HTTP routes + DNS records). The install pipeline lives
 * entirely in `apps/api/src/modules/mail/` because every step needs a
 * `CommandExecutor` - there is no pure half worth extracting.
 *
 * Future candidates: autodiscover XML schemas, DKIM key format,
 * deliverability scoring - anything declarative + pure stays here.
 */

export * from "./routing";
