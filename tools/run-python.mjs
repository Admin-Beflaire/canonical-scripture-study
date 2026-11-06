import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

/** @type {Record<string, string[]>} */
const commands = {
  import: ["-c", "import css_shared; import css_preparation"],
  test: ["-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py", "-v"],
  boundaries: ["tools/check_python_boundaries.py"],
  repository: ["tools/repository/run_test_profile.py", "repository"],
};
const command = process.argv[2];
if (!command || !Object.hasOwn(commands, command)) throw new Error("Choose import, test, boundaries or repository");
const interpreter = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const result = spawnSync(interpreter, commands[command], {
  shell: false,
  stdio: "inherit",
  env: {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: ["packages/shared-python/src", "services/maintenance/data-preparation/src"].map(p => resolve(p)).join(delimiter),
  },
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Python checks stopped by ${result.signal}`);
process.exitCode = result.status ?? 1;
