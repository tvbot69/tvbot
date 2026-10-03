import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 40 * 1024;
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP.has(entry)) continue;
    if (statSync(full).isDirectory()) {
      if (full.replace(/\\/g, '/').endsWith('/docs/archive')) continue;
      walk(full, out);
    } else if (full.endsWith('.md')) {
      if (full.replace(/\\/g, '/').includes('/docs/archive/')) continue;
      out.push(full);
    }
  }
  return out;
};

const main = (): void => {
  const bad: string[] = [];
  for (const file of walk(process.cwd())) {
    const size = statSync(file).size;
    if (size > LIMIT) bad.push(`${file}: ${(size / 1024).toFixed(1)}KB`);
  }
  if (bad.length > 0) {
    console.error(`docs size check failed, ${bad.length} file(s) over 40KB:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('docs size check ok');
};

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-docs-size.ts')) main();
