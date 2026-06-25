// Chat command — `c0de chat <message>` (design spec §11.3).
//
// Runs the Print mode with the provided message and prints the agent's
// response to stdout. For scriptable one-shot Q&A.
//
// Data + functions: no class, no this, no enum.

import { loadConfig } from "../../core/config";
import { runPrintMode } from "../modes/print";

// ---------------------------------------------------------------------------
// chat — execute `c0de chat`
// ---------------------------------------------------------------------------

export async function chat(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: c0de chat <message>");
    process.exit(1);
  }

  const message = args.join(" ");

  const config = await loadConfig(process.cwd());

  const output = await runPrintMode(config, message, {
    format: "text",
  });

  console.log(output);
}
