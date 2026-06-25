// Attach command — `c0de attach <url>` (design spec §11.4).
//
// Connects to a running `c0de` server via WebSocket, sends a user message,
// and streams back agent events.
//
// Data + functions: no class, no this, no enum.

import { connectToServer, receiveEvents, sendMessage } from "../modes/attach";

// ---------------------------------------------------------------------------
// attach — connect to a server and send a message
// ---------------------------------------------------------------------------

export async function attach(url: string, message?: string): Promise<void> {
  const connection = await connectToServer(url);
  console.log(`Connected to ${connection.url}`);

  if (message) {
    sendMessage(connection, message);
  }

  for await (const event of receiveEvents(connection)) {
    if (event.type === "text") {
      process.stdout.write(String(event.data));
    } else if (event.type === "done") {
      console.log();
      break;
    }
  }

  connection.ws.close();
}