const path = require("node:path");
const {spawnSync} = require("node:child_process");

const root = path.resolve(__dirname, "..");
const result = spawnSync(process.execPath, [
  "--test",
  path.join(root, "tests", "market-sync-regression.test.cjs"),
], {
  cwd: root,
  env: {...process.env, A_SHARE_REVIEW_RUN_LOCK_INTEGRATION: "1"},
  stdio: "inherit",
});

process.exit(result.status ?? 1);
