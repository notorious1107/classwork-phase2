import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let failed = false;
for (const dir of ['backend', 'frontend', 'scripts', 'tests']) {
  for (const name of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exit(1);
console.log('所有 JavaScript 文件语法检查通过');
