import { build } from "esbuild";

const entries = {
  study: ["services/study/src/index.ts", "neutral"],
  control: ["services/maintenance/control/src/index.ts", "neutral"],
  preparation: ["services/maintenance/data-preparation/src/index.ts", "node"],
  shared: ["packages/shared/src/index.ts", "neutral"],
};
const target = process.argv[2];
if (!Object.hasOwn(entries, target)) throw new Error("Choose study, control, preparation or shared");
const [entry, platform] = entries[target];
await build({ entryPoints: [entry], bundle: true, format: "esm", platform,
  target: "es2023", outfile: `dist/${target}/index.js`, logLevel: "info" });

