import { AsyncLocalStorage } from "node:async_hooks";
import { managedMailNamespacePattern } from "@repo/contracts/managed-mail";

const login = new AsyncLocalStorage<string>();

export function withMailDatabaseTenant<T>(namespace: string, run: () => T): T {
  if (!managedMailNamespacePattern.test(namespace)) throw new Error("Invalid mail database tenant.");
  return login.run(namespace, run);
}

export function mailDatabaseTenant() {
  return login.getStore();
}

/** Only the DNS-proof reservation writer needs host authority during a tenant request. */
export function reserveAsMailOperator<T>(writeReservation: () => T): T {
  return login.exit(writeReservation);
}
