const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'coverage', 'node_modules', 'uploads']);

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : collectJavaScriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

const files = collectJavaScriptFiles(backendRoot);
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(backendRoot, file),
      output: String(result.stderr || result.stdout || 'Unknown syntax error').trim(),
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    process.stderr.write(`\n${failure.file}\n${failure.output}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed for ${files.length} backend JavaScript files.\n`);
}
