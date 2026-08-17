import { defineWorkspace } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url))
};

// The workspace splits the suite into two projects:
//   - "web": the browser/store/component tests (jsdom, parallel).
//   - "native": real-process execution tests (node). These spawn npm/node and
//     are timing-sensitive, so they run serially to stay deterministic under
//     load instead of being pushed past their bounds by parallel workers.
export default defineWorkspace([
  {
    esbuild: { jsx: "automatic" },
    test: {
      name: "web",
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      clearMocks: true
    },
    resolve: { alias }
  },
  {
    esbuild: { jsx: "automatic" },
    test: {
      name: "native",
      environment: "node",
      include: ["native/**/*.test.ts"],
      fileParallelism: false,
      testTimeout: 30_000
    },
    resolve: { alias }
  }
]);