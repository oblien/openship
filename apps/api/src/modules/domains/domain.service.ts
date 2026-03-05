/**
 * Domain service — manage custom domains and SSL certificates.
 */

export async function addDomain(projectId: string, domain: string) {
  // TODO: Store domain, create TXT verification record
}

export async function verifyDomain(domainId: string) {
  // TODO: DNS lookup to check verification
}

export async function removeDomain(domainId: string) {
  // TODO: Remove domain and revoke certificate
}

export async function provisionSSL(domain: string) {
  // TODO: Issue Let's Encrypt certificate
}
