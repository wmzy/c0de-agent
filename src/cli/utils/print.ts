// CLI output utilities (design spec §11.1 — src/cli/utils/).
//
// Data + functions: no class, no this, no enum.

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// openBrowser — open a URL in the default browser
// ---------------------------------------------------------------------------

export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    } else {
      // Linux and others
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
    console.log(`Opened browser at ${url}`);
  } catch {
    console.log(`Could not open browser automatically. Visit ${url} in your browser.`);
  }
}
