// Static syntax/manifest check only. Does not execute extension code or contact a host/API.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceTextModule } from 'node:vm';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const name of ['index.js', 'core.js']) {
    new SourceTextModule(readFileSync(resolve(root, name), 'utf8'), { identifier: name });
}
for (const name of [manifest.js, manifest.css]) {
    if (!existsSync(resolve(root, name))) throw new Error(`Missing manifest file: ${name}`);
}
console.log('Static JS/JSON syntax and manifest paths OK. No extension execution, tests, private data, or API calls.');
