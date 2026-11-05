import { readFileSync } from 'node:fs';
import { validateHandoff } from './evaluation.mjs';
try {
  const handoff = JSON.parse(readFileSync(0, 'utf8'));
  validateHandoff(handoff);
  console.log(JSON.stringify({ task: handoff.task, state: handoff.state, nextCommand: handoff.resumeCommands[0], remaining: handoff.remaining, kind: 'clean-process-smoke-only' }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
