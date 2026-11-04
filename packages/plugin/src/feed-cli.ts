#!/usr/bin/env node
/**
 * `korsi-feed`: push a file to one of the organization's feeds in Korsi, from a command line.
 *
 * The same commands as the Python `korsi-feed` -- `whoami`, `schema`, `check`, `push`, `status`,
 * `apply` -- and the same exit codes: 0 done, 2 held for the connection's owner, 3 rows wait or
 * were refused, 4 the file has rows Korsi would refuse, 1 anything else. The credential is read from
 * `KORSI_SYSTEM_CLIENT_ID`, `KORSI_SYSTEM_CLIENT_SECRET`, `KORSI_SYSTEM_TOKEN_ENDPOINT`,
 * `KORSI_SYSTEM_SCOPE` and `KORSI_SYSTEM_API`. It reads CSV, JSON and JSON lines; save a
 * spreadsheet as CSV, or use the Python one, which reads `.xlsx` too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { KorsiError, KorsiRefused } from './errors.js';
import {
  checkRows,
  credentialsFromEnv,
  push,
  readRows,
  SystemClient,
  type FeedRowOutcome,
  type FeedRunView,
  type FeedSchema,
} from './feeds.js';

export const EXIT = { done: 0, failed: 1, held: 2, attention: 3, invalid: 4 } as const;

const WORDS: Record<string, string> = {
  applied: 'applied: written',
  trial: 'reported only: nothing was written (trial mode or a dry run)',
  held: "held: a large change, waiting for the connection's owner to press apply",
  open: 'open: still taking batches',
  failed: 'failed: nothing was written',
  expired: 'expired: nothing was written',
};

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  stdin: () => string;
  env: Readonly<Record<string, string | undefined>>;
  client?: (env: Readonly<Record<string, string | undefined>>) => SystemClient;
}

const summary = (run: FeedRunView): string => {
  const counts = Object.entries(run.counts)
    .map(([name, value]) => `${name} ${value}`)
    .join(', ');
  let line = `run ${run.id} (${run.feed}): ${WORDS[run.status] ?? run.status}`;
  if (run.held_reason) line += ` [${run.held_reason}: ${run.changes} of ${run.existing}]`;
  if (run.missing) line += `; not in this list: ${run.missing}`;
  return `${line}\n  ${counts}`;
};

const rowLines = (rows: FeedRowOutcome[]): string =>
  rows
    .map(
      (row) =>
        `  row ${row.position} ${row.source_key ?? '-'}: ${row.status}` +
        (row.reason ? ` (${row.reason}${row.field ? `: ${row.field}` : ''})` : '')
    )
    .join('\n');

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const valued = new Set(['--feed', '--schema', '--key', '--rows', '-o', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (valued.has(word)) {
      flags.set(word === '-o' ? '--output' : word, argv[index + 1] ?? '');
      index += 1;
    } else if (word.startsWith('--')) flags.set(word, true);
    else positional.push(word);
  }
  const [command = 'help', ...rest] = positional;
  return { command, positional: rest, flags };
}

const flag = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const USAGE = `korsi-feed whoami
korsi-feed schema FEED [-o schema.json]
korsi-feed check FILE --feed FEED [--schema schema.json]
korsi-feed push FILE --feed FEED [--dry-run] [--complete] [--key KEY] [--schema schema.json]
korsi-feed status RUN_ID --feed FEED [--rows waiting]
korsi-feed apply RUN_ID --feed FEED
Add --json for Korsi's answers as JSON. FILE may be - for standard input.`;

/** The command line, with its world handed in so a test can run it. Returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const parsed = parse(argv);
  const json = parsed.flags.has('--json');
  const dump = (value: unknown) => io.out(JSON.stringify(value, null, 2));
  const feed = flag(parsed, '--feed');
  const makeClient = () =>
    io.client ? io.client(io.env) : new SystemClient(credentialsFromEnv(io.env));
  const schemaOf = async (client: SystemClient | null, name: string): Promise<FeedSchema> => {
    const saved = flag(parsed, '--schema');
    if (saved) return JSON.parse(io.readFile(saved)) as FeedSchema;
    if (!client) throw new Error('give --schema, or set the connection credentials');
    return client.feedSchema(name);
  };
  const source = (path: string | undefined): string => {
    if (!path) throw new Error('name a file, or - for standard input');
    return path === '-' ? io.stdin() : io.readFile(path);
  };
  try {
    switch (parsed.command) {
      case 'whoami': {
        const me = await makeClient().connection();
        if (json) dump(me);
        else {
          io.out(`${me.name} (${me.connection_id}): ${me.mode}`);
          for (const grant of me.feeds) {
            io.out(`  ${grant.feed}${grant.create_people ? '  creates people' : ''}`);
          }
        }
        return EXIT.done;
      }
      case 'schema': {
        const name = parsed.positional[0] ?? feed;
        if (!name) throw new Error('name the feed');
        const text = JSON.stringify(await makeClient().feedSchema(name), null, 2);
        const output = flag(parsed, '--output');
        if (output) io.writeFile(output, text);
        else io.out(text);
        return EXIT.done;
      }
      case 'check': {
        if (!feed) throw new Error('give --feed');
        const client = flag(parsed, '--schema') ? null : makeClient();
        const schema = await schemaOf(client, feed);
        const read = readRows(source(parsed.positional[0]), schema);
        for (const column of read.refusedColumns) {
          io.err(`column not read -- Korsi never keeps it: ${column}`);
        }
        for (const column of read.unknownColumns) {
          io.err(`column not read -- no field of ${feed} is called that: ${column}`);
        }
        const problems = checkRows(schema, read.rows);
        for (const problem of problems) {
          io.out(
            `row ${problem.position} ${problem.sourceKey ?? '-'}: ${problem.field} ${problem.reason}`
          );
        }
        io.out(`${read.rows.length} rows, ${problems.length} would be refused`);
        return problems.length ? EXIT.invalid : EXIT.done;
      }
      case 'push': {
        if (!feed) throw new Error('give --feed');
        const client = makeClient();
        const schema = await schemaOf(client, feed);
        const read = readRows(source(parsed.positional[0]), schema);
        for (const column of [...read.refusedColumns, ...read.unknownColumns]) {
          io.err(`column not read: ${column}`);
        }
        if (!read.rows.length) {
          io.err('no rows to push');
          return EXIT.failed;
        }
        if (schema.max_rows && read.rows.length > schema.max_rows) {
          io.err(`${read.rows.length} rows; one run of ${feed} carries at most ${schema.max_rows}`);
          return EXIT.failed;
        }
        const key = flag(parsed, '--key');
        const result = await push(client, feed, read.rows, {
          complete: parsed.flags.has('--complete'),
          dryRun: parsed.flags.has('--dry-run'),
          ...(key ? { key } : {}),
        });
        if (json) dump(result);
        else {
          io.out(summary(result.run));
          if (result.attention.length) io.out(rowLines(result.attention));
        }
        if (result.run.status === 'held') return EXIT.held;
        return result.attention.length ? EXIT.attention : EXIT.done;
      }
      case 'status': {
        const runId = parsed.positional[0];
        if (!feed || !runId) throw new Error('give the run id and --feed');
        const client = makeClient();
        const report = await client.run(feed, runId);
        const rows = await client.outcomes(feed, runId, flag(parsed, '--rows'));
        if (json) dump({ run: report.run, outcomes: rows });
        else {
          io.out(summary(report.run));
          if (rows.length) io.out(rowLines(rows));
        }
        return report.run.status === 'held' ? EXIT.held : EXIT.done;
      }
      case 'apply': {
        const runId = parsed.positional[0];
        if (!feed || !runId) throw new Error('give the run id and --feed');
        const applied = await makeClient().apply(feed, runId);
        if (json) dump(applied);
        else io.out(summary(applied));
        return applied.status === 'held' ? EXIT.held : EXIT.done;
      }
      default:
        io.out(USAGE);
        return parsed.command === 'help' ? EXIT.done : EXIT.failed;
    }
  } catch (error) {
    if (error instanceof KorsiRefused) {
      io.err(`Korsi refused: ${error.code}${error.title ? ` -- ${error.title}` : ''}`);
      if (Object.keys(error.params).length) io.err(`  ${JSON.stringify(error.params)}`);
    } else if (error instanceof KorsiError || error instanceof Error) {
      io.err(error.message);
    } else io.err(String(error));
    return EXIT.failed;
  }
}

const isMain = (): boolean => {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry as string).href;
};

if (isMain()) {
  const code = await run(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readFile: (path) => readFileSync(path, 'utf-8'),
    writeFile: (path, text) => writeFileSync(path, text, 'utf-8'),
    stdin: () => readFileSync(0, 'utf-8'),
    env: process.env,
  });
  process.exitCode = code;
}
