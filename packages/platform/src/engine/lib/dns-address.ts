/** Addresses commonly synthesized by local fake-IP DNS interceptors. */
export function isSyntheticDnsAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const head = Number.parseInt(ip.split(":")[0] || "0", 16);
    return head >= 0xfc00 && head <= 0xfdff;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 240) return true;
  return false;
}
