import { build } from "esbuild";

/** @type {Record<string, [string, import("esbuild").Platform]>} */
const entries = {
  study: ["services/study/src/index.ts", "neutral"],
  control: ["services/maintenance/control/src/index.ts", "neutral"],
  shared: ["packages/shared/src/index.ts", "neutral"],
};
const target = process.argv[2];
if (!target || !Object.hasOwn(entries, target)) throw new Error("Choose study, control or shared");
const [entry, platform] = entries[target];
await build({ entryPoints: [entry], bundle: true, format: "esm", platform,
  conditions: ["workerd", "worker", "browser"], target: "es2023", outfile: `dist/${target}/index.js`, logLevel: "info" });

