import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/fetch.ts"],
  format: ["esm"],
  target: "node20",
  dts: { entry: ["src/index.ts", "src/fetch.ts"] },
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.build.json",
});
