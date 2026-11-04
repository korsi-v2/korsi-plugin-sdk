import { describe, expect, it } from 'vitest';

import {
  batches,
  checkFeeds,
  checkRows,
  defineFeed,
  KorsiRefused,
  push,
  readRows,
  runKey,
  SystemClient,
  type FeedSchema,
} from '@korsi/plugin';

import { EXIT, run } from '../src/feed-cli.js';

const SCHEMA: FeedSchema = {
  feed: 'korsi.people',
  kind: 'korsi',
  names: {},
  plugin_id: null,
  record_type: null,
  visibility: null,
  source_key: 'source_key',
  person_fields: {},
  upsert: null,
  row_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['source_key'],
    $defs: { EmploymentType: { type: 'string', enum: ['full_time', 'part_time'] } },
    properties: {
      source_key: { type: 'string', maxLength: 64 },
      given_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      weekly_hours: { anyOf: [{ type: 'integer', maximum: 80 }, { type: 'null' }] },
      employment_type: { anyOf: [{ $ref: '#/$defs/EmploymentType' }, { type: 'null' }] },
    },
  },
  headers: {
    source_key: { fa: ['کد'], en: ['Employee ID'] },
    given_name: { en: ['First name'] },
    weekly_hours: { en: ['Hours'] },
  },
  refused_fields: ['national_id', 'salary'],
  sample: {},
  max_rows: 5000,
};

const CREDENTIALS = {
  clientId: 'system-abc',
  clientSecret: 'shown-once',
  tokenEndpoint: 'https://id.example.test/oauth/v2/token',
  scope: 'openid',
  apiBase: 'https://acme.korsi.test/system/v1',
};

type Json = Record<string, unknown>;

/** Korsi's door, as much as a push needs: runs by key, batches by number. */
class FakeDoor {
  runs = new Map<string, Json>();
  keys = new Map<string, string>();
  tokens = 0;
  throttle = 0;
  commits = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });
    if (url.pathname.endsWith('/oauth/v2/token')) {
      this.tokens += 1;
      expect(headers.get('authorization')).toMatch(/^Basic /);
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('korsi-system-api')).toBe('1.0');
    if (this.throttle) {
      this.throttle -= 1;
      return json(429, { code: 'system.rate_limited' }, { 'retry-after': '1' });
    }
    const parts = url.pathname.replace('/system/v1/', '').split('/');
    if (parts[0] === 'connection') {
      return json(200, { connection_id: 'c1', name: 'HR', mode: 'active', feeds: [], limits: {} });
    }
    if (parts.length === 2) return json(200, SCHEMA);
    if (parts[2] === 'runs' && parts.length === 3) {
      const key = headers.get('idempotency-key') as string;
      const known = this.keys.get(key);
      if (known) return json(200, this.runs.get(known));
      const id = `r${this.runs.size + 1}`;
      this.keys.set(key, id);
      const made = {
        id,
        feed: 'korsi.people',
        status: 'open',
        rows: 0,
        counts: {},
        missing: 0,
        batches: {} as Record<string, Json[]>,
        ...(JSON.parse(String(init?.body)) as Json),
      };
      this.runs.set(id, made);
      return json(201, made);
    }
    const current = this.runs.get(parts[3] ?? '');
    if (!current) return json(404, { code: 'resource.not_found' });
    if (parts[4] === 'batches') {
      (current.batches as Record<string, Json[]>)[parts[5] as string] = (
        JSON.parse(String(init?.body)) as { rows: Json[] }
      ).rows;
      return json(200, { run_id: current.id, seq: Number(parts[5]) });
    }
    if (parts[4] === 'commit') {
      this.commits += 1;
      const count = Object.values(current.batches as Record<string, Json[]>).flat().length;
      current.rows = count;
      current.status = current.dry_run ? 'trial' : 'applied';
      current.counts = { created: count - 1, waiting: 1 };
      return json(200, current);
    }
    if (parts[4] === 'apply') {
      current.status = 'applied';
      return json(200, current);
    }
    return json(200, {
      run: current,
      outcomes: [
        { position: 0, source_key: 'E-1', status: 'created' },
        { position: 1, source_key: 'E-2', status: 'waiting', reason: 'no_match' },
      ],
      next_after: null,
    });
  };
}

const client = (door: FakeDoor) =>
  new SystemClient(CREDENTIALS, { fetch: door.fetch, sleep: async () => undefined });

describe('declaring a feed', () => {
  it('builds the entry and finds what Korsi would refuse', () => {
    const feed = defineFeed('tickets', {
      names: { en: 'Tickets' },
      consent: { en: 'Tickets from your ticket system.' },
      recordType: 'ticket',
      sourceKey: 'ticket_no',
      fields: ['title', 'assignee'],
      personFields: { assignee: ['email'] },
    });
    const manifest: Json = {
      scopes: { required: ['records.own'] },
      record_types: [
        {
          key: 'ticket',
          visibility: 'organization',
          schema: {
            properties: {
              ticket_no: { type: 'string', maxLength: 40 },
              title: { type: 'string' },
              assignee: { type: 'string' },
            },
          },
        },
      ],
      feeds: [feed],
    };
    expect(checkFeeds(manifest)).toEqual([]);
    const wrong = { ...manifest, scopes: {}, feeds: [{ ...feed, fields: ['title', 'gone'] }] };
    const problems = checkFeeds(wrong).join('\n');
    expect(problems).toContain('records.own');
    expect(problems).toContain('does not declare');
  });
});

describe('a file', () => {
  it('is read by its header words, and what Korsi never keeps is not read', () => {
    const text = '﻿کد,First name,Hours,Salary,Shoe\nE-1,"Sara, A",44,100,40\nE-2,,,,\n';
    const read = readRows(text, SCHEMA);
    expect(read.rows).toEqual([
      { source_key: 'E-1', given_name: 'Sara, A', weekly_hours: 44 },
      { source_key: 'E-2' },
    ]);
    expect(read.refusedColumns).toEqual(['Salary']);
    expect(read.unknownColumns).toEqual(['Shoe']);
    expect(readRows('{"source_key":"E-3"}\n{"source_key":"E-4"}', SCHEMA).rows).toHaveLength(2);
  });

  it('is checked offline as Korsi would on arrival', () => {
    const problems = checkRows(SCHEMA, [
      { source_key: 'E-1', weekly_hours: 44, employment_type: 'full_time' },
      { source_key: 'E-2', national_id: '1' },
      { source_key: 'E-3', shoe: 40 },
      { given_name: 'No key' },
      { source_key: 'E-5', weekly_hours: 99 },
      { source_key: 'E-6', employment_type: 'seasonal' },
      { source_key: 'E-1' },
    ]).map((problem) => [problem.position, problem.field, problem.reason.split(':')[0]]);
    expect(problems).toEqual([
      [1, 'national_id', 'field_refused'],
      [2, 'shoe', 'field_unknown'],
      [3, 'source_key', 'required'],
      [4, 'weekly_hours', 'invalid'],
      [5, 'employment_type', 'invalid'],
      [6, 'source_key', 'duplicate_key'],
    ]);
  });

  it('goes in batches the door takes, under a key that follows the rows', () => {
    const rows = Array.from({ length: 1201 }, (_, index) => ({ source_key: `E-${index}` }));
    expect(batches(rows).map((chunk) => chunk.length)).toEqual([500, 500, 201]);
    expect(runKey('f', rows)).toBe(runKey('f', rows));
    expect(runKey('f', rows, { complete: true })).not.toBe(runKey('f', rows));
  });
});

describe('the door', () => {
  it('pushes once, waits out a 429, and the same rows again are the same run', async () => {
    const door = new FakeDoor();
    door.throttle = 1;
    const rows = Array.from({ length: 600 }, (_, index) => ({ source_key: `E-${index}` }));
    const system = client(door);
    const first = await push(system, 'korsi.people', rows);
    const again = await push(system, 'korsi.people', rows);
    expect(first.run.status).toBe('applied');
    expect(first.run.rows).toBe(600);
    expect(first.attention.map((row) => row.source_key)).toEqual(['E-2']);
    expect(again.run.id).toBe(first.run.id);
    expect(door.commits).toBe(1);
    expect(door.tokens).toBe(1);
  });

  it("carries Korsi's code on a refusal", async () => {
    const door = new FakeDoor();
    await expect(client(door).run('korsi.people', 'nope')).rejects.toBeInstanceOf(KorsiRefused);
  });
});

describe('korsi-feed', () => {
  const world = (door: FakeDoor, files: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
        readFile: (path: string) => files[path] ?? '',
        writeFile: (path: string, text: string) => {
          files[path] = text;
        },
        stdin: () => '',
        env: {},
        client: () => client(door),
      },
    };
  };

  it('pushes a file, says what waits, and applies its own dry run', async () => {
    const door = new FakeDoor();
    const { out, io } = world(door, { 'staff.csv': 'Employee ID,First name\nE-1,Sara\nE-2,Ali\n' });
    expect(await run(['push', 'staff.csv', '--feed', 'korsi.people'], io)).toBe(EXIT.attention);
    expect(out.join('\n')).toContain('applied');
    expect(out.join('\n')).toContain('E-2: waiting (no_match)');
    await run(['push', 'staff.csv', '--feed', 'korsi.people', '--dry-run'], io);
    const dry = [...door.runs.values()].find((made) => made.dry_run) as Json;
    expect(dry.status).toBe('trial');
    expect(await run(['apply', String(dry.id), '--feed', 'korsi.people'], io)).toBe(EXIT.done);
    expect(dry.status).toBe('applied');
  });

  it('checks a file against a saved schema with no Korsi at all', async () => {
    const { out, io } = world(new FakeDoor(), {
      'people.json': JSON.stringify(SCHEMA),
      'staff.json': JSON.stringify([{ source_key: 'E-1' }, { source_key: 'E-2', salary: 9 }]),
    });
    const code = await run(
      ['check', 'staff.json', '--feed', 'korsi.people', '--schema', 'people.json'],
      {
        ...io,
        client: () => {
          throw new Error('no Korsi here');
        },
      }
    );
    expect(code).toBe(EXIT.invalid);
    expect(out.join('\n')).toContain('salary field_refused');
  });
});
