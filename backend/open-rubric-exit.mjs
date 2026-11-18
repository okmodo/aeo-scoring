// Offline retained-artifact replay. This does not run or approve a model.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { restoreRubricAssessment, isValidatedRubricAssessment } from './ai-rubric-assessment.mjs';
const file=process.argv[2];
if (!file) throw new Error('Pass the exported fixture path');
const {snapshot,extracted,artifact,expected}=JSON.parse(await readFile(file,'utf8'));
const assessment=await restoreRubricAssessment(snapshot,extracted,artifact);
assert.equal(isValidatedRubricAssessment(assessment,snapshot,extracted),true);
assert.equal(assessment.findings['C5.claim-support'].status,expected.claimStatus);
assert.equal(assessment.findings['C5.claim-support'].fraction,expected.claimFraction);
assert.equal(assessment.findings['C5.consistency'].status,expected.consistencyStatus);
assert.equal(assessment.findings['C1.identity'].status,expected.identityStatus);
await assert.rejects(()=>restoreRubricAssessment({...snapshot,rawHtml:snapshot.rawHtml+' changed'},extracted,artifact));
const tampered=structuredClone(artifact); tampered.profile.slots[0].label='Altered expectation';
await assert.rejects(()=>restoreRubricAssessment(snapshot,extracted,tampered));
process.stdout.write(JSON.stringify({claimStatus:assessment.findings['C5.claim-support'].status,claimFraction:assessment.findings['C5.claim-support'].fraction,consistencyStatus:assessment.findings['C5.consistency'].status,identityStatus:assessment.findings['C1.identity'].status,changedSourceRejected:true,changedProfileRejected:true})+'\n');
