// CLI package public API (design spec §11).
//
// Re-exports every function the rest of the codebase may depend on.

export { cli } from "./cli";

export { serve } from "./commands/serve";
export { chat } from "./commands/chat";
export { init as initConfig } from "./commands/init";
export { configGet, configSet } from "./commands/config";

export { runPrintMode } from "./modes/print";
export type { PrintOptions } from "./modes/print";
