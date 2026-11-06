import service, { handleAuditRequest } from './service.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';

const egress = createPublicEgress();
export default {
  fetch(request, env, ctx) {
    return handleAuditRequest(request, env, ctx, { egress, normalizeUrl: normalizePublicTarget });
  },
  scheduled: service.scheduled,
};
