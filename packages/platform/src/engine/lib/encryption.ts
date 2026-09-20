/** API process composition over the shared encryption implementation. */
import { createEncryption, type Encryption } from "@repo/platform";
import { env } from "../config/env";
export { encryptWithKey, decryptWithKey, encryptBytesWithKey, decryptBytesWithKey } from "@repo/platform";
let secrets: Encryption | undefined;
function instanceSecrets(): Encryption { return secrets ??= createEncryption(env.BETTER_AUTH_SECRET); }
export const encrypt = (plaintext: string) => instanceSecrets().encrypt(plaintext);
export const decrypt = (sealed: string) => instanceSecrets().decrypt(sealed);
export const decryptEnvMap: Encryption["decryptEnvMap"] = (...args) => instanceSecrets().decryptEnvMap(...args);
export function closeEncryption(): void { secrets?.close(); secrets = undefined; }
