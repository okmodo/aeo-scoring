// Operator-only local entry point. No token argument, remote DB or deployment.
import { readFileSync, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { runUsageCollection } from './usage-collection.mjs';

let sqlite;
try {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--db', '--fixture', '--mapping'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Invalid arguments');
    options[args[i]] = args[i + 1];
  }
  if (!options['--db']) throw Error('A private local database path is required');
  const fixture = options['--fixture'] ? JSON.parse(readFileSync(options['--fixture'], 'utf8')) : null;
  const accountId = fixture?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const subscriptionId = fixture?.subscriptionId ?? process.env.CLOUDFLARE_SUBSCRIPTION_ID;
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId || '')) throw Error('Invalid scope');
  const directory = lstatSync(dirname(resolve(options['--db'])));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) ||
      (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw Error('Use a trusted private directory');
  const fd = openSync(options['--db'], constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  closeSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('Database must be private and owned by the operator');
  sqlite = new DatabaseSync(options['--db']);
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return {
    first: async () => stmt.get(...args) ?? null, run: async () => stmt.run(...args),
  }; } }; } };
  const config = { accountId, subscriptionId,
    token: fixture ? 'offline-fixture' : process.env.CLOUDFLARE_BILLING_READ_TOKEN,
    mapping: fixture?.mapping ?? (options['--mapping'] ? JSON.parse(readFileSync(options['--mapping'], 'utf8')) : undefined),
  };
  if (fixture) config.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.cloudflare.com' || !parsed.pathname.startsWith(`/client/v4/accounts/${accountId}/`)) throw Error('Unexpected fixture request');
    const key = parsed.pathname.endsWith('/info') ? 'info' : parsed.pathname.endsWith('/subscriptions') ? 'subscriptions' : 'usage';
    return Response.json(fixture[key]);
  };
  const result = await runUsageCollection({ db, config, now: fixture ? () => fixture.now : Date.now });
  console.log(JSON.stringify({ ...result, sourceMode: fixture ? 'offline_fixture' : 'read_only_api' }));
  // A successful acquisition is still blocked, not evidence of usable allowance.
  process.exitCode = 2;
} catch {
  console.error('Usage collection failed. No budget was activated. Check scope, private state file, credentials and documented access.');
  process.exitCode = 1;
} finally { sqlite?.close(); }
