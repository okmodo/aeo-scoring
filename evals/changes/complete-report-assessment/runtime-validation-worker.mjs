// Temporary, fixed-target release validation. Uses the reviewed service entry.
import { handleAuditRequest } from '../../../backend/service.mjs';
import { retrieve } from '../../../backend/retrieval.mjs';
import { createPublicEgress, normalizePublicTarget } from '../../../backend/public-egress.mjs';
const target = 'https://kokatat.com/naiad-pfd-lvhnai';
export default {
  fetch(request, env, ctx) {
    return handleAuditRequest(request, env, ctx, {
      egress: createPublicEgress(), normalizeUrl: normalizePublicTarget,
      allowsProduct: url => url === target,
      retrievePage: (url, options) => retrieve(url, { ...options, observeSitemap: true, observeGuides: true }),
      contentCalibrationApproved: true,
    });
  },
};
