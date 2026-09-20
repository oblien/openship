/** Shared passive cipher; importing it never opens a database or reads process env. */
export {
  createEncryption,
  encryptWithKey,
  decryptWithKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
  type Encryption,
} from "@repo/db/encryption";
