import react from "@vitejs/plugin-react"
import { configDefaults, defineConfig } from "vitest/config"
import { WxtVitest } from "wxt/testing/vitest-plugin"

export default defineConfig({
  // TODO: remove any
  plugins: [WxtVitest() as any, react()],
  test: {
    // Vitest 4's process and worker-thread pools can time out while starting
    // on macOS. VM threads avoid that startup path. A single worker also keeps
    // the shared fake-browser and storage test doubles deterministic.
    pool: "vmThreads",
    maxWorkers: 1,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/repos/**"],
    environment: "node",
    environmentOptions: {
      // jsdom defaults to http://localhost:3000/, which built-in site rules
      // keyed on localhost (e.g. sillytavern) silently match — tests written
      // on the default URL would run under that site's semantics instead of
      // the shipped defaults. Pin a neutral host no rule matches; per-file
      // @vitest-environment-options pragmas still override this.
      jsdom: { url: "https://neutral-test.example/" },
    },
    globals: true,
    setupFiles: "vitest.setup.ts",
    watch: false,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      // include: ['src/**/*.{ts,tsx}'],
      // exclude: ['src/**/*.spec.ts']
    },
  },
})
