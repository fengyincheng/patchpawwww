import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(projectRoot, 'web/dist');

type FrontendAssets = { cssPath: string; jsPath: string; css: Buffer; js: Buffer };

function assetPath(html: string, pattern: RegExp, kind: string): string {
  const path = html.match(pattern)?.[1];
  assert.ok(path, `frontend HTML does not reference a ${kind} asset`);
  assert.ok(path.startsWith('/assets/'), `${kind} asset must be content-hashed under /assets/`);
  return path;
}

async function localAssets(): Promise<FrontendAssets> {
  const html = await readFile(resolve(distRoot, 'index.html'), 'utf8');
  const cssPath = assetPath(html, /href="([^"]+\.css)"/, 'CSS');
  const jsPath = assetPath(html, /src="([^"]+\.js)"/, 'JavaScript');
  const css = await readFile(resolve(distRoot, cssPath.slice(1)));
  const js = await readFile(resolve(distRoot, jsPath.slice(1)));
  const stack = css.toString().match(/--sans:\s*([^;}]+)/)?.[1]?.trim();
  assert.equal(stack?.split(',')[0]?.trim(), 'Geist', 'built CSS does not select Geist first');
  return { cssPath, jsPath, css, js };
}

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

async function remoteBuffer(url: URL): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      assert.equal(response.status, 200, `${url} returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 10) await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
  }
  throw lastError;
}

export async function verifyFrontend(urls: string[]): Promise<void> {
  const local = await localAssets();
  for (const value of urls) {
    const base = new URL(value.endsWith('/') ? value : `${value}/`);
    const html = (await remoteBuffer(base)).toString();
    assert.equal(assetPath(html, /href="([^"]+\.css)"/, 'CSS'), local.cssPath, `${base} serves a different CSS build`);
    assert.equal(assetPath(html, /src="([^"]+\.js)"/, 'JavaScript'), local.jsPath, `${base} serves a different JavaScript build`);
    const remoteCss = await remoteBuffer(new URL(local.cssPath, base));
    const remoteJs = await remoteBuffer(new URL(local.jsPath, base));
    assert.equal(digest(remoteCss), digest(local.css), `${base} CSS content differs from the verified build`);
    assert.equal(digest(remoteJs), digest(local.js), `${base} JavaScript content differs from the verified build`);
    console.log(`verified frontend ${base} (${local.cssPath}, ${local.jsPath})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const urls = process.argv.slice(2);
  assert.ok(urls.length > 0, 'usage: npm run verify:frontend -- <url> [url...]');
  await verifyFrontend(urls);
}
