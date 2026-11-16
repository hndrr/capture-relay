import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
const version = manifest.version;
const outDir = path.resolve('release');
const zipName = `capture-relay-v${version}.zip`;
const zipPath = path.join(outDir, zipName);

await rm('dist', { recursive: true, force: true });
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });

await mkdir(outDir, { recursive: true });
await rm(zipPath, { force: true });

execFileSync('zip', ['-r', zipPath, '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(`Packaged ${path.relative(process.cwd(), zipPath)}`);
