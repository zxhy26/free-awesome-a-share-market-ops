const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const appRoot = path.join(repositoryRoot, "app");
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
}

collect(appRoot);

for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`JavaScript 语法检查通过：${files.length} 个文件\n`);
