import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

function printVersion(): void {
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
}

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  printVersion();
} else {
  printVersion();
  process.stderr.write('(skeleton) 其余参数尚未实现\n');
}
