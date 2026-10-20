/**
 * Routes Korsi adds reach the client by generation alone: the patch's routes, merged into the
 * plane's real document, become methods that type-check and call Korsi the way the routes say.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { KorsiClient } from '@korsi/plugin';

const ROOT = process.cwd();
const OUT = resolve(ROOT, 'packages/plugin/test/.generated');
const CASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let operations: any;

beforeAll(async () => {
  const document = JSON.parse(readFileSync(resolve(ROOT, 'openapi/plugin-v1.json'), 'utf8'));
  const patch = JSON.parse(
    readFileSync(resolve(ROOT, 'openapi/testdata/org-api.patch.json'), 'utf8')
  );
  Object.assign(document.paths, patch.paths);
  Object.assign(document.components.schemas, patch.schemas);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'document.json'), JSON.stringify(document));
  execFileSync('python3', [
    resolve(ROOT, 'scripts/generate_models.py'),
    '--document',
    resolve(OUT, 'document.json'),
    '--python-out',
    resolve(OUT, 'python'),
    '--ts-out',
    OUT,
  ]);
  operations = await import(/* @vite-ignore */ resolve(OUT, 'operations.ts'));
}, 30_000);

describe('a route Korsi adds', () => {
  it('type-checks as generated', () => {
    writeFileSync(
      resolve(OUT, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../../../tsconfig.base.json',
        compilerOptions: { noEmit: true, composite: false, lib: ['ES2022'], types: [] },
        include: ['models.ts', 'operations.ts'],
      })
    );
    execFileSync(resolve(ROOT, 'node_modules/.bin/tsc'), ['-p', resolve(OUT, 'tsconfig.json')]);
  }, 30_000);

  it('is a method of the client, calling Korsi as the route says', async () => {
    const requests: { method: string; url: URL; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const path = url.pathname.replace('/plugin/v1', '');
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (path === '/cases') {
        return url.searchParams.has('cursor')
          ? json({ items: [{ id: '2' }], next_cursor: null })
          : json({ items: [{ id: '1' }], next_cursor: 'p2' });
      }
      if (path === `/cases/${CASE}`) return json({ id: CASE, title: 'x', status: 'open' });
      if (path === '/calendar') return json({ items: [] });
      if (path === '/memory/search') return json({ items: [{ text: 'found', score: 0.9 }] });
      return new Response(null, { status: 404 });
    };
    const real = new KorsiClient('https://korsi.test/plugin/v1', 'token', { fetch });
    // The generated half of the client, over the real client's transport.
    class NextClient extends operations.PlaneOperations {
      protected call(method: string, path: string, options?: object) {
        return (real as any).call(method, path, options);
      }
    }
    const client: any = new NextClient();

    const since = new Date('2026-10-01T00:00:00Z');
    const cases: string[] = [];
    for await (const item of client.iterCases({ status: 'open', updatedSince: since })) {
      cases.push(item.id);
    }
    expect(cases).toEqual(['1', '2']);
    expect((await client.getCase(CASE)).status).toBe('open');
    await client.calendar({ from: since, to: '2026-10-31T00:00:00Z', includeDeclined: true });
    expect((await client.searchMemory({ query: 'contract' })).items[0].text).toBe('found');

    const [first, second, single, calendar, search] = requests;
    expect(first!.url.searchParams.get('status')).toBe('open');
    expect(first!.url.searchParams.get('updated_since')).toBe('2026-10-01T00:00:00.000Z');
    expect(first!.url.searchParams.has('cursor')).toBe(false);
    expect(second!.url.searchParams.get('cursor')).toBe('p2');
    expect(single!.url.pathname).toBe(`/plugin/v1/cases/${CASE}`);
    expect(calendar!.url.searchParams.get('include_declined')).toBe('true');
    expect(search).toMatchObject({ method: 'POST', body: { query: 'contract' } });
    expect(operations.ROUTES['GET /cases/{case_id}/activity']).toBe('caseActivity');
    expect(operations.ROUTES['GET /installation']).toBe('whoami');
  });
});
