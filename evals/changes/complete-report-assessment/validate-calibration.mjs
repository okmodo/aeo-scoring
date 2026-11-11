import { readFileSync, writeFileSync } from 'node:fs';
import { decodeContentFacts, decodeConditionInspection } from '../../../backend/content-facts.mjs';
import { assessContentFacts } from '../../../backend/fact-grading.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';
const [casePath, wirePath, outputPath, conditionPath] = process.argv.slice(2);
const item = JSON.parse(readFileSync(casePath, 'utf8'));
const wire = JSON.parse(readFileSync(wirePath, 'utf8'));
const output = wire.result?.response ?? wire.result?.choices?.[0]?.message?.content;
const condition = conditionPath ? JSON.parse(readFileSync(conditionPath, 'utf8')) : null;
const facts = condition ? decodeConditionInspection(item.prepared, item.request, output, condition.result?.response ?? condition.result?.choices?.[0]?.message?.content)
  : decodeContentFacts(item.prepared, item.request, output, { requireConditionChecks: true });
const grade = assessContentFacts(item.snapshot, item.extracted, facts);
const report = scoreAudit(item.snapshot, item.extracted, { validatedFacts: facts });
const differences = Object.entries(item.expected?.checks || {}).flatMap(([id, expected]) => {
  const finding = grade.findings[id];
  const actual = ['total', 'structure', 'content'].includes(id) ? report.score?.[id]
    : finding?.status === 'measured' ? finding.fraction : finding?.status;
  return actual === expected ? [] : [{ id, expected, actual }];
});
if (outputPath) writeFileSync(outputPath, JSON.stringify({ facts, grade, report, differences }), { mode: 0o600 });
console.log(JSON.stringify({ valid: true, proposedFacts: typeof output === 'string' ? JSON.parse(output).facts.length : output.facts.length,
  validatedFacts: facts.facts.length, differences, usage: wire.result?.usage }));
process.exitCode = differences.length ? 1 : 0;
