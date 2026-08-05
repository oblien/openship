// node-entry.ts — thin wrapper with a #!/usr/bin/env node shebang.
//
// PURPOSE: npm reads the shebang of the `bin` file to generate Windows
// launchers (openship.cmd / openship.ps1). The main dist/index.js uses
// #!/usr/bin/env sh intentionally — it lets the official Bun-based
// installer run the CLI on Bun-only Unix boxes where Node is absent.
//
// npm users always have Node, so #!/usr/bin/env node is correct for them.
// tsup builds this as dist/node-entry.js with that shebang; package.json
// points `bin.openship` here so npm generates correct Windows launchers.
//
// On Unix, #!/usr/bin/env node is also fine — node runs this wrapper,
// which imports the fully-bundled CLI. The polyglot dist/index.js is only
// used by the official curl-based installer on Bun-only boxes.
import "./index.js";
