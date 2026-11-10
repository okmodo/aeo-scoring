// Hash exact source body inputs and the files providing support/fact responses.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syntheticCases } from './cases.mjs';
const data = await readFile(new URL('../fixtures/complete-engine/complete-shirt.html', import.meta.url), 'utf8');
const hash = v => createHash('sha256').update(v).digest('hex');
for (const [name, input] of Object.entries(syntheticCases(data))) console.log(JSON.stringify({ name, bytes: Buffer.byteLength(input.html), sha256: hash(input.html) }));
for (const file of ['../fixtures/complete-engine/support.json', '../fixtures/content-facts/reference-shirt.mjs']) {
  const contents = await readFile(new URL(file, import.meta.url));
  console.log(JSON.stringify({ file, bytes: contents.length, sha256: hash(contents) }));
}
