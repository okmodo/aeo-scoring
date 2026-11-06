import test from 'node:test';
import assert from 'node:assert/strict';
import { robotsPathMatch, ROBOTS_MATCH_MAX_WORK } from './robots-path.mjs';

const match = (path, rule) => robotsPathMatch(path, rule).matches;

test('matches literal prefixes case-sensitively without regex semantics', () => {
  assert.equal(match('/fishheads', '/fish'), true);
  assert.equal(match('/Fish', '/fish'), false);
  assert.equal(match('/aXb', '/a.b'), false);
  assert.equal(match('/a.b[1]', '/a.b[1]'), true);
});

test('matches wildcards and terminal anchors', () => {
  assert.equal(match('/fish.php', '/fish*.php$'), true);
  assert.equal(match('/fish/abc.php', '/fish*.php$'), true);
  assert.equal(match('/fish/abc.php/other', '/fish*.php$'), false);
  assert.equal(match('/fish/abc.php/other', '/fish*.php'), true);
  assert.equal(match('/products/account', '/*/products/account'), false);
  assert.equal(match('/en/products/account', '/*/products/account'), true);
  assert.equal(match('/a$b', '/a$b'), true);
});

test('reports rule specificity and ignores trailing wildcard for prefix rules', () => {
  assert.equal(robotsPathMatch('/page.htm', '/*.htm').specificity, 6);
  assert.equal(robotsPathMatch('/', '/$').specificity, 2);
  assert.equal(robotsPathMatch('/fish', '/fish***').specificity, 5);
});

test('rejects excessive matching work deterministically', () => {
  const pattern = '/*'.repeat(1001) + 'b$';
  assert.ok((pattern.length + 1) * 2001 > ROBOTS_MATCH_MAX_WORK);
  assert.throws(() => robotsPathMatch('/' + 'a'.repeat(1999), pattern), RangeError);
});
