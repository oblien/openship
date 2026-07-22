import {
  deployLuaScripts,
  OPENRESTY_DEFAULT_PATHS,
  OPENRESTY_LUA_DIR,
} from "../../src/infra/openresty-lua";
import type { CommandExecutor } from "../../src/types";

const writtenFiles: string[] = [];
const executor = {
  exec: async () => "",
  writeFile: async (path: string) => {
    if (path.startsWith(`${OPENRESTY_LUA_DIR}/`)) {
      writtenFiles.push(path.slice(OPENRESTY_LUA_DIR.length + 1));
    }
  },
  exists: async () => true,
  mkdir: async () => {},
} as CommandExecutor;

await deployLuaScripts(executor, OPENRESTY_DEFAULT_PATHS);
process.stdout.write(JSON.stringify(writtenFiles));
