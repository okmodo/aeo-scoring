// Match already-validated/decoded paths. The caller remains responsible for URL
// encoding ambiguity and for treating a RangeError as an unknown policy.
// RFC 9309 §2.2.2–3: https://www.rfc-editor.org/rfc/rfc9309.html
// Google path examples: https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec
export const ROBOTS_MATCH_MAX_WORK = 120_000;

export function robotsPathMatch(path, rule) {
  const anchored = rule.endsWith('$');
  const pattern = anchored ? rule.slice(0, -1) : rule.replace(/\*+$/, '');
  // Cap work before allocating or matching. This also prevents policy-controlled
  // patterns from creating backtracking or unbounded quadratic CPU consumption.
  if ((pattern.length + 1) * (path.length + 1) > ROBOTS_MATCH_MAX_WORK) {
    throw new RangeError('Robots path match exceeds work limit');
  }
  let previous = new Uint8Array(path.length + 1);
  let current = new Uint8Array(path.length + 1);
  previous[0] = 1;
  for (const char of pattern) {
    current[0] = 0;
    if (char === '*') {
      current[0] = previous[0];
      for (let i = 1; i <= path.length; i++) current[i] = previous[i] || current[i - 1];
    } else {
      for (let i = 1; i <= path.length; i++) current[i] = previous[i - 1] && path[i - 1] === char;
    }
    [previous, current] = [current, previous];
  }
  const matches = anchored ? Boolean(previous[path.length]) : previous.some(Boolean);
  // Google counts syntax in path length (including terminal $); trailing * is
  // ignored because it is equivalent to a prefix rule. UTF-8 byte length is
  // used per RFC 9309's octet-based specificity requirement.
  const specificity = new TextEncoder().encode(pattern + (anchored ? '$' : '')).length;
  return { matches, specificity };
}
