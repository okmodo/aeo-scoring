import service, { handleAuditRequest } from './service.mjs';
import { createPreviewEgress } from './preview-egress.mjs';

const egress = createPreviewEgress({
  productUrls: ['https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html'],
});

export default {
  fetch(request, env, ctx) {
    return handleAuditRequest(request, env, ctx, { egress, allowsProduct: egress.allowsProduct });
  },
  scheduled: service.scheduled,
};
