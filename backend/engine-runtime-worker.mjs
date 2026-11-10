// Local native-runtime replay entry point. No bindings or deployment configuration.
import { extract } from './retrieval.mjs';
import { scoreAudit } from './scoring.mjs';
import { buildSemanticRequest, validateSemanticResponse } from './semantic-assessment.mjs';
import { inspectProductSchema } from './structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from './content-facts.mjs';
export default { async fetch(request) {
        const { html, url, support = {}, judgments = null, facts = null } = await request.json();
        const snapshot = { url, observedAt: '2026-11-09T00:00:00.000Z', body: html, htmlLimited: null, ...support };
        const extracted = await extract(snapshot);
        let report = scoreAudit(snapshot, extracted);
        const semanticRequest = buildSemanticRequest(snapshot, extracted, report, { product: inspectProductSchema(snapshot, extracted).product });
        const factsRequest = buildContentFactsRequest(semanticRequest);
        if (facts) report = scoreAudit(snapshot, extracted, { validatedFacts: decodeContentFacts(semanticRequest, factsRequest, facts) });
        if (judgments) {
            const semantic = validateSemanticResponse(semanticRequest, judgments);
            report = scoreAudit(snapshot, extracted, { semantic: { ...semantic, status: 'assessed', model: 'independently-reviewed-synthetic-judgments' } });
        }
        return Response.json({ extracted, report, semanticRequest, factsRequest });
    } };
