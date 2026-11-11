import { createAnalyticsAllowanceGuard } from '../../../backend/analytics-allowance.mjs';
import { METRICS } from '../../../backend/allowance-policy.mjs';

export default { async fetch(_request, env) {
  const start = Date.UTC(2026, 10, 11, 12);
  let accountAi = 805;
  const guard = createAnalyticsAllowanceGuard(env.AUDIT_DB, {accountId:'native-fixture',subscriptionId:'fixture'}, {
    collect: async ({now}) => ({mode:'estimated',observedAt:now,cycleStart:start-1000,cycleEnd:start+86400000,
      aiDay:'2026-11-11',usage:{...Object.fromEntries(METRICS.map(key=>[key,0])),aiNeurons:accountAi}}),
  });
  const first = await guard.reserve({id:'native-first',costs:{aiNeurons:5000},now:start});
  const settlement = await guard.settle({id:'native-first',costs:{aiNeurons:100},now:start+1000});
  const duplicate = await guard.settle({id:'native-first',costs:{aiNeurons:100},now:start+1000});
  accountAi = 905;
  const capacity = await guard.reserve({id:'native-capacity',costs:{aiNeurons:5095},now:start+300001});
  const exhausted = await guard.reserve({id:'native-over',costs:{aiNeurons:1},now:start+300002});
  return Response.json({first,settlement,duplicate,capacity,exhausted});
} };
