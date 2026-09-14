import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Geist is the first-choice UI font', async () => {
  const css = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const stack = css.match(/--sans:\s*([^;}]+)/)?.[1]?.trim();

  assert.ok(stack, 'the UI font stack should be declared');
  assert.equal(stack.split(',')[0]?.trim(), 'Geist');
});

test('display typography stays restrained in both languages', async () => {
  const css = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const heading = css.match(/h1\s*\{([^}]+)\}/)?.[1];

  assert.ok(heading, 'the primary heading style should exist');
  assert.match(heading, /font-size:\s*clamp\(30px,\s*2\.6vw,\s*38px\)/);
  assert.match(heading, /font-weight:\s*500/);
  assert.doesNotMatch(css, /html\[lang="zh-CN"\]\s+h1\s*\{/);
});
