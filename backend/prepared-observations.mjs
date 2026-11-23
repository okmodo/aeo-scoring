// Only the explicitly retained observations are restored into an audit snapshot.
export function restorePreparedObservations(prepared) {
  const observations = prepared?.observations;
  const initial = observations?.initialExtracted;
  const available = Boolean(initial && typeof initial === 'object' && initial.coverage && Array.isArray(initial.jsonLd));
  const empty = {productHtml:null,jsonLd:[],coverage:{html:false,usable:false,jsonLdTruncated:true}};
  const support = {};
  for (const key of ['crawlerPolicy','sitemap','guides','policies']) {
    if (observations?.support && Object.hasOwn(observations.support,key)) support[key] = observations.support[key];
  }
  return {initialExtracted:available ? initial : empty,initialAvailable:available,support};
}
