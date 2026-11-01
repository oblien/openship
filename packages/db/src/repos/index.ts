export * from "./factory";
import { createRepositories } from "./factory";
import { db, storageEncryption } from "../client";

export const repos = createRepositories(db, storageEncryption);
