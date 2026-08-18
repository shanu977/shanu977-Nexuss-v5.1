import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url))
};

export default defineConfig({
  // Vite 8 transformed JSX/TSX with oxc (the esbuild option is deprecated and
  // ignored when oxc is active), so configure the React automatic runtime here.
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react"
    }
  },
  resolve: {
    alias
  },
  test: {
    // The suite splits into two projects:
    //   - "web": the browser/store/component tests (jsdom, parallel).
    //   - "native": real-process execution tests (node). These spawn npm/node
    //     and are timing-sensitive, so they run serially to stay deterministic
    //     under load instead of being pushed past their bounds by workers.
    projects: [
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup.ts"],
          clearMocks: true
        }
      },
      {
        extends: true,
        test: {
          name: "native",
          environment: "node",
          include: ["native/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000
        }
      }
    ]
  }
});
