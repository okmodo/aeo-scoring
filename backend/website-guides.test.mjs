import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWebsiteGuides } from './website-guides.mjs';

const product = 'https://example.com/products/boots';
const body = '# Example\n\nWe sell outdoor equipment and clothing for hikers.\n\n[Boots](https://example.com/products/boots)';
const guide = (text = body, url = 'https://example.com/llms.txt') => ({ url, text });

test('awards only confirmed guides with safe fixed evidence', () => {
  const result = assessWebsiteGuides({ llms: guide(), agents: guide(body, 'https://example.com/AGENTS.md') }, product);
  assert.deepEqual(Object.keys(result), ['S7.identity', 'S8.context']);
  assert.equal(result['S7.identity'].fraction, 1);
  assert.equal(result['S8.context'].url, 'https://example.com/AGENTS.md');
  assert.ok(!JSON.stringify(result).includes('hikers'));
});

test('requires independent site, purpose and exact product link signals', () => {
  for (const text of [body.replace('# Example', '# Other'), body.replace('We sell', 'We describe'), body.replace(product, `${product}?variant=1`), body.replace(product, 'https://other.com/products/boots'), '# Example\nRun npm install to build the repository.']) {
    assert.deepEqual(assessWebsiteGuides({ llms: guide(text) }, product), {});
  }
  assert.deepEqual(assessWebsiteGuides({ llms: guide(body, 'https://other.com/llms.txt') }, product), {});
});

test('does not count hidden, fenced, indented, inline-code, or image evidence', () => {
  for (const text of [`\`\`\`md\n${body}\n\`\`\``, `<!-- ${body} -->`, `<pre>${body}</pre>`, body.split('\n').map(x => `    ${x}`).join('\n'), body.replace('[Boots]', '![Boots]'), body.replace('# Example', '`# Example`'), `${body}\n\`\`\`open`]) {
    assert.deepEqual(assessWebsiteGuides({ agents: guide(text, 'https://example.com/AGENTS.md') }, product), {});
  }
});

test('handles missing and malformed input without awarding credit', () => {
  assert.deepEqual(assessWebsiteGuides({}, product), {});
  assert.deepEqual(assessWebsiteGuides({ llms: guide() }, 'not a URL'), {});
  assert.deepEqual(assessWebsiteGuides({ llms: { url: null, text: body } }, product), {});
});

test('supports the llms.txt summary blockquote and rejects false fence closures', () => {
  const quoted = body.replace('We sell', '> We sell');
  assert.equal(assessWebsiteGuides({ llms: guide(quoted) }, product)['S7.identity'].fraction, 1);
  const stillCode = '```md\n```not-a-closing-fence\n' + body + '\n```';
  assert.deepEqual(assessWebsiteGuides({ llms: guide(stillCode) }, product), {});
  assert.deepEqual(assessWebsiteGuides({ llms: guide('`\n' + body + '\n`') }, product), {});
  assert.deepEqual(assessWebsiteGuides({ llms: guide(body.replace('# Example', '## Example')) }, product), {});
});

test('does not treat reference titles as visible guide purpose', () => {
  const hidden = '# Example\n\n[ref]: /foo "\nWe sell outdoor equipment and clothing for hikers.\n"\n\n[Boots](' + product + ')';
  assert.deepEqual(assessWebsiteGuides({ llms: guide(hidden), agents: guide(hidden, 'https://example.com/AGENTS.md') }, product), {});
});
