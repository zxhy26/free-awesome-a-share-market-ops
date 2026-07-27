const path = require("path");
const {spawnSync} = require("child_process");
const updater = require("./next-week-events-updater");

module.exports = updater;

if (require.main === module) {
  const canonicalPath = path.join(__dirname, "next-week-events-updater.js");
  const result = spawnSync(process.execPath, [canonicalPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
