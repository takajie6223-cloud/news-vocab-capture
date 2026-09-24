import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(join(root, '../extension/src/content/content.js'), 'utf8');
const stub = readFileSync(join(root, 'content-inject.js'), 'utf8');
// 把 content.js 拼进测试页
const page = readFileSync(join(root, 'page.html'), 'utf8')
  .replace('<script src="content-inject.js"></script>', `<script>\n${contentJs}\n</script>`);
writeFileSync(join(root, 'page.html.built'), page);
console.log('built', join(root, 'page.html.built'), 'bytes', page.length);
