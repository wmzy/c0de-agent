#!/usr/bin/env node

// @c0de/cli - c0de command entry point

import { createInterface } from "node:readline";
import { createAgent } from "@c0de/core";
import { createProvider } from "@c0de/llm";
import { createMemoryStore } from "@c0de/session";
import { createDefaultRegistry } from "@c0de/tools";
import { createExecutor } from "@c0de/tools";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "serve") {
    // Start the server
    const { default: app } = await import("@c0de/server");
    const { serve } = await import("@hono/node-server");
    const port = Number.parseInt(args[1] ?? "3000", 10);

    console.log(`Starting server on port ${port}...`);
    serve({
      fetch: app.fetch,
      port,
    });
    console.log(`Server running at http://localhost:${port}`);
    return;
  }

  if (command === "help" || command === undefined) {
    console.log(`
c0de-agent v0.0.1 - AI Coding Assistant

Usage:
  c0de [command] [options]

Commands:
  serve [port]    Start the HTTP server (default: 3000)
  chat            Start interactive chat (default)
  help            Show this help message

Environment:
  OPENAI_API_KEY      API key for LLM provider
  OPENAI_BASE_URL     Custom API base URL
  MODEL_NAME          Model name (default: gpt-4o)
  WORKING_DIRECTORY   Working directory for tools
`);
    return;
  }

  // Interactive chat mode
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  const provider = createProvider({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.MODEL_NAME,
  });

  const registry = createDefaultRegistry();
  const executor = createExecutor(registry);

  const agent = createAgent({
    provider,
    tools: registry,
    executor,
    config: {
      workingDirectory: process.env.WORKING_DIRECTORY ?? process.cwd(),
    },
  });

  const sessionStore = createMemoryStore();
  await sessionStore.create("CLI Chat");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("c0de-agent v0.0.1 - Interactive Chat");
  console.log('Type your message, or "exit" to quit.\n');

  const askQuestion = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("You: ", resolve);
    });

  try {
    while (true) {
      const input = await askQuestion();

      if (input.trim().toLowerCase() === "exit") {
        break;
      }

      if (!input.trim()) continue;

      process.stdout.write("\nAssistant: ");

      for await (const event of agent.run(input)) {
        if (event.type === "message") {
          process.stdout.write(event.data as string);
        } else if (event.type === "tool_call") {
          const call = event.data as { name: string };
          process.stdout.write(`\n  [Calling tool: ${call.name}]`);
        }
      }

      console.log("\n");
    }
  } finally {
    rl.close();
  }
}

main().catch(console.error);
