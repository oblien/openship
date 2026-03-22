export interface TarTransferOptions {
  excludes?: string[];
  includes?: string[];
}

export function getTarCreateEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPYFILE_DISABLE: "1",
    COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
  };
}

export function getTarCreateArgs(
  localPath: string,
  options?: TarTransferOptions,
): string[] {
  const args: string[] = [];

  if (process.platform === "darwin") {
    args.push("--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags");
  }

  args.push("-czf", "-", "-C", localPath);

  if (options?.includes?.length) {
    args.push(...options.includes);
    return args;
  }

  for (const exclude of options?.excludes ?? []) {
    args.push(`--exclude=${exclude}`);
  }

  args.push(".");
  return args;
}