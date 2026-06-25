import path from "path";
import react from "@vitejs/plugin-react";
import wyw from "@wyw-in-js/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// Custom plugin to integrate Hono API app
function honoApiPlugin(): Plugin {
  return {
    name: "hono-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, _next) => {
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With",
          );
          res.setHeader("Access-Control-Max-Age", "86400");
          res.statusCode = 204;
          res.end();
          return;
        }

        try {
          const { createApp } = await import("./src/api");
          const { createDB } = await import("./src/db/client");
          const { loadConfig } = await import("./src/core/config");
          const { createProviderRegistry } = await import("./src/llm/provider");
          const { createDefaultRegistry } = await import("./src/tools");

          const cwd = process.env.WORKING_DIRECTORY ?? process.cwd();
          const db = await createDB({ driver: "pglite" });
          const config = await loadConfig(cwd);
          const providerRegistry = createProviderRegistry(config.providers ?? []);
          const toolRegistry = createDefaultRegistry();

          const apiApp = createApp({
            db,
            config,
            providerRegistry,
            toolRegistry,
            workingDirectory: cwd,
          });
          const url = new URL("/api" + (req.url || "/"), `http://${req.headers.host}`);

          let body: string | undefined = undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            body = await new Promise<string>((resolve, reject) => {
              let data = "";
              req.on("data", (chunk) => {
                data += chunk;
              });
              req.on("end", () => resolve(data));
              req.on("error", reject);
            });
          }

          const request = new Request(url.toString(), {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body,
          });

          const response = await apiApp.fetch(request);
          res.statusCode = response.status;
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
          response.headers.forEach((value: string, key: string) => {
            res.setHeader(key, value);
          });
          const responseBody = await response.text();
          res.end(responseBody);
        } catch (error) {
          console.error("API Error:", error);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [
    react({ exclude: ["node_modules/**"] }),
    wyw({
      sourceMap: process.env.NODE_ENV !== "production",
      displayName: process.env.NODE_ENV !== "production",
      exclude: ["node_modules/**"],
      evaluate: false,
    }),
    honoApiPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "./dist/client",
    emptyOutDir: true,
    sourcemap: true,
    target: "esnext",
    rollupOptions: {
      input: { main: path.resolve(__dirname, "index.html") },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/"))
            return "vendor";
          if (id.includes("node_modules/")) return "vendor-libs";
        },
      },
    },
  },
  server: {
    port: Number.parseInt(process.env.PORT || "3020"),
    host: true,
    cors: {
      origin: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      credentials: true,
    },
  },
  publicDir: path.resolve(__dirname, "public"),
  ssr: { noExternal: ["hono"] },
});
