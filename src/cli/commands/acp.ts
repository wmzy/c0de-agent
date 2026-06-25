// ACP command — `c0de acp` (design spec §11.2).
//
// Starts the ACP protocol loop (JSON-RPC over stdin/stdout).
// Delegates to runACPMode in modes/acp.ts.
//
// Data + functions: no class, no this, no enum.

import { loadConfig } from "../../core/config";
import { runACPMode } from "../modes/acp";

// ---------------------------------------------------------------------------
// acp — execute `c0de acp`
// ---------------------------------------------------------------------------

export async function acp(): Promise<void> {
  const config = await loadConfig(process.cwd());
  await runACPMode(config);
}
