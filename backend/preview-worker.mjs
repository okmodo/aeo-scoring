import service from './service.mjs';
import { createPreviewEgress } from './preview-egress.mjs';

const egress = createPreviewEgress({
  productUrls: ['https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html'],
});

export default {
  fetch(request, env, ctx) {
    return service.fetch(request, {
      AUDIT_DB: env.AUDIT_DB,
      AUDIT_RATE_SECRET: env.AUDIT_RATE_SECRET,
      AUDIT_EGRESS: egress,
    }, ctx);
  },
  scheduled: service.scheduled,
};
