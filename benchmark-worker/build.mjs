import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = process.argv[2];
if (!outDir || !resolve(outDir).startsWith('/private/tmp/')) throw new Error('Provide an output directory under /private/tmp');
await build({ configFile: false, logLevel: 'warn', build: { outDir: resolve(outDir), emptyOutDir: false, target: 'es2022', minify: false, lib: { entry: resolve('benchmark-worker/worker.mjs'), formats: ['es'], fileName: () => '_worker.js' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
await mkdir(resolve(outDir, 'static'), { recursive: true });
await writeFile(resolve(outDir, 'static/index.html'), '<!doctype html><title>Benchmark</title>\n');
