import service, { handleAuditRequest } from './service.mjs';
import { retrieve } from './retrieval.mjs';
import { createPublicEgress, normalizePublicTarget } from './public-egress.mjs';

const egress = createPublicEgress();
const retrievePage = (url, options) => retrieve(url, { ...options, observeSitemap: true, observeGuides: true });
export default {
  fetch(request, env, ctx) {
    return handleAuditRequest(request, env, ctx, { egress, normalizeUrl: normalizePublicTarget, retrievePage });
  },
  scheduled: service.scheduled,
};
