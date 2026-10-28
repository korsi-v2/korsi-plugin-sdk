# @korsi/plugin

The server side of a [Korsi](https://korsi.ai) plugin, for Node 20.19+: the same surface as the
Python SDK `korsi-plugin`, except a durable event log -- `MemoryEventLog` forgets on a restart, so
give `{ events }` your own `EventLog` (three methods) over the database you already have.

```ts
import express from 'express';
import { KorsiPlugin, RequestRejected, KorsiRefused, Topic, SYNC, VERIFY, headerValue } from '@korsi/plugin';

const plugin = new KorsiPlugin(store); // your InstallationStore; { events } for a durable EventLog
const app = express();
const raw = express.raw({ type: 'application/json' }); // verify the bytes Korsi signed
const signature = (req) => headerValue(req.headers, 'korsi-signature');

app.post('/korsi/lifecycle', raw, async (req, res) => {
  const result = await plugin.lifecycle(req.body, signature(req));
  res.json({ status: result.status });
});

app.post('/korsi/events', raw, async (req, res) => {
  const status = await plugin.event(req.body, signature(req), async (installation, event) => {
    if (event.topic === Topic.proposalSettled) { /* ... */ }
    if (event.topic === Topic.mailReceived) {
      // A person's mail, read as them with the handle Korsi minted for this delivery.
      const mail = await plugin.client(installation, event.handle!).readMail(event.subjectId!);
    }
  });
  res.json({ status });
});

// A read tool Korsyar asks, for a person: answer within ten seconds, change nothing.
app.post('/korsi/tools/:name', raw, async (req, res) => {
  const { installation, call } = await plugin.toolCall(req.params.name, req.body, signature(req));
  const korsi = plugin.client(installation, call.handle); // as the person
  res.json({ content: (await korsi.records('thread')).items });
});

// An action tool (ADR-0080): a change the person confirmed on a card the plugin's specialist made.
app.post('/korsi/actions/:name', raw, async (req, res) => {
  res.json(await plugin.actionCall(req.params.name, req.body, signature(req)));
});

// An integration plugin (ADR-0067): Korsi asks about a person's connected account.
app.post('/korsi/connections', raw, async (req, res) => {
  const { call } = await plugin.connectionCall(req.body, signature(req));
  if (call.call === VERIFY) res.json(await checkAccount(call.values, call.secrets)); // never log secrets
  else if (call.call === SYNC) res.json(await changesSince(call.state, call.limits));
  else res.json({ result: await onCalendar(call.op, call.args) });
});

app.get('/api/me', async (req, res) => {
  const who = await plugin.person({
    authorization: req.headers.authorization,
    installationId: headerValue(req.headers, 'x-korsi-installation'),
  });
  if (!who.caller.permissions.includes('see_compensation')) { /* the plugin's own rule */ }
  res.json(await plugin.client(who.installation, who.handle).wallet());
});

app.use((error, req, res, next) => {
  // `code` in the body: Korsi -- and the Bridge, for a page's call -- reads it, never the status.
  if (error instanceof RequestRejected) {
    return res.status(error.status).json({ code: error.code, detail: error.message });
  }
  if (error instanceof KorsiRefused) return res.status(error.status).json({ code: error.code });
  next(error);
});
```

`KorsiClient` covers every route of `/plugin/v1`, typed from Korsi's OpenAPI document. Amounts of
MU stay decimal strings; `Wallet.covers` and `compareAmounts` compare them exactly. The manifest's
own types are `Manifest` (`import type { Manifest } from '@korsi/plugin'`; `Manifest.SpecialistSpec`,
`Manifest.ToolSpec` with its `kind`, `Manifest.ExtensionPoint` with `meeting.live.panel`).

## A plugin that keeps nothing

Every delivery -- an event, a tool or action call, a connection call, a page's call -- for an
installation the plugin has no credential for throws `Unprovisioned`: answer it **409 with
`{ "code": "plugin.unprovisioned" }` in the body**, as the handler above does. Korsi then gives the
credential again (`installed` arrives at `/korsi/lifecycle`) and asks once more; a page's call goes
through the Bridge, which asks Korsi the same and calls again (ADR-0086). Only the code counts: a
409 without it is the plugin's own refusal, and an event answered so is given up.

Korsi delivers at least once. `MemoryEventLog` and the answers `actionCall` remembers spare a repeat
while the process lives; after a restart they are gone, so a handler that must not do a thing twice
keys it in the plugin's records (a record written under the same external id replaces, never
doubles; `expectedVersion` guards against a lost update).

**Placement `instance`.** Korsi runs the plugin's image with no volume, a 64 MB `/tmp`, and one way
out: the egress proxy it names in `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. The SDK reaches Korsi
through that proxy whenever one is set (undici's `EnvHttpProxyAgent`; `createKorsiFetch` is the same
`fetch` for the plugin's own calls out). Keep installations in memory and everything durable in the
plugin's records.

## Action tools

A manifest tool with `"kind": "action"` changes the plugin's own records, and only the plugin's
specialist uses it: Korsyar shows the person a card, and Korsi calls the action once they confirm
it. Register a handler for each:

```ts
plugin.registerAction('create_position', async ({ call, arguments: args, korsi, caller, signal }) => {
  const caseId = call.earlier.case?.result?.case_id as string | undefined; // an earlier change's case
  const position = await createPosition(korsi, args, caseId, call.idempotencyKey);
  return {
    ok: true,
    summary: said(call.locale, 'position_created'), // the card shows it, in the person's language
    records: [{ type: 'position', external_id: position.id }],
  };
}, { parse: (args) => PositionInput.parse(args) }); // your own check; Korsi checked input_schema

// Refusing is an answer, not an error: the card shows the message as the plugin's words.
return { ok: false, error: { code: 'position_closed', message: said(call.locale, 'position_closed') } };
```

`actionCall` verifies the signature, checks the body names the tool the path does, vouches for the
person (`caller`, with `caller.permissions`), runs the handler once per `call.idempotencyKey`
(`<card_id>:<change_key>`), and cuts the answer to Korsi's limits (summary 300 characters, message
500, 20 records). `signal` aborts a little before Korsi's 30 seconds run out. A throw, a malformed
answer or no answer in time is `plugin.action_failed` on the card: Korsi cannot say whether the
change was made. `verifiedAction` is the verified body alone, for a plugin that dispatches itself.

**When it arrives.** Korsi makes a card's changes in order and commits each before the next, so an
action call arrives only after the earlier changes on its card are committed: what they made is
there to read back through the plane. `call.earlier.<key>.result` carries what each earlier change
made, such as the `case_id` of the case a `case.create` made; an earlier action's own answer is its
`summary` and `records`. `call.idempotencyKey`, `<card_id>:<change_key>` from `call.cardId` and
`call.changeKey`, is the same on every delivery: key the change by it in the plugin's records and
answer the same when it is already made. `call.arguments` may be the person's edit -- the whole
object as they saved it on the card, checked against the tool's `input_schema` again, never a patch
over what the specialist proposed.

**Korsyar's conversation is not the plugin's.** A specialist never holds Korsyar's session id:
Korsi runs it in a hidden session of its own, with the person's grant copied onto every request.
Korsi's MCP server refuses a plugin that passes `session_id`, on its own credential or on a person's
handle: a plugin reads as itself, or as the person its handle stands for, narrowed to its scopes.
Never ask for a `session_id` in a tool's `input_schema`.

## What the plane offers in plugin API 1.2

```ts
const korsi = plugin.client(installation, handle);

// Records by their declared fields (ADR-0085): up to five conditions, all of which hold.
await korsi.queryRecords('application', {
  where: [{ field: 'stage', op: 'in', value: ['screening', 'interview'] }, { field: 'fit', op: 'gte', value: 70 }],
  order_by: { field: 'received_at', dir: 'desc' },
});
for await (const record of korsi.iterQueryRecords('application', { where })) { /* ... */ }
await korsi.records('position', { query: 'backend' }); // words in the title

// Files a person handed the plugin in Korsi's picker (files.read; the page's pickFile).
const file = await korsi.file(fileId);                    // name, size, media_type, granted_by
const bytes = await (await korsi.fileContent(fileId)).arrayBuffer(); // or .body, streamed
const { text, extraction } = await korsi.fileText(fileId, { wait: true }); // a scan: OCR, waited for

// Korsi's language models, at the publisher's cost (models.use, a trusted scope; ADR-0081).
const models = await korsi.models();                      // id, context window, $ per million tokens
const answer = await korsi.complete({
  model: models[0]!.id, max_tokens: 800, purpose: 'cv_extract', idempotency_key: `cv:${fileId}:v1`,
  messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
  response_format: { type: 'json_object' },
}); // answer.content, answer.usd_cost ("0.0042", exact), answer.finish_reason

// When people are free (calendar.read, on a person's behalf): times only, nothing booked.
await korsi.freeSlots({ user_ids, from: '2026-11-02', to: '2026-11-13', duration_minutes: 45 });

// A meeting the plugin hosts (meetings.host, trusted; ADR-0083), and what is said in it live.
const meeting = await korsi.hostMeeting({
  external_id: `interview:${kitId}`, title, case_id: caseId,
  participant_user_ids, // members, you too when named; attendees as on Korsi's own form
  guests: [{ name: candidateName }], // no account: a name alone, which grants nothing
  restricted: true, recording: { consent: 'required', audio_days: 30, transcript_days: 180 },
});
const live = await korsi.liveTranscript(meeting.id, { since: coveredThrough }); // meetings.live.read
await korsi.getCase(caseId); // stages: [{ key, name, position, current }] in order
```

Refusals to branch on, all `KorsiRefused` with a `code` (`Code.*`):
- `plugin.publisher_funds` (402, `isPublisherFunds`): the publisher's paid services -- models, OCR,
  the specialist -- are paused until its wallet is topped up. Everything else keeps working.
- `plugin.model_not_allowed` (422), and `plugin.rate_limited` (429) with `retryAfter` when the
  installation spent its `models` budget (60 calls a minute). `complete()` asks again by itself,
  with the same `idempotency_key`, when Korsi did not answer (`retries`, 2 by default): Korsi answers
  a key it answered with that answer, for an hour, and never completes twice.
- `plugin.text_pending` (409, `isTextPending`): a scan Korsi is still reading. Ask again after
  `textPendingSeconds(error)` (`params.retry_after_seconds`, also sent as `Retry-After`), or pass
  `{ wait: true }`. `plugin.text_unavailable` (409) says why in `params.reason`: `scan` (no
  `models.use`), `ocr_unavailable`, `archive`, `kind`, `too_large` (past 25 MB, a zip that unpacks
  past what Korsi reads, a PDF past 500 pages, more than a million characters) or `unreadable`.
- `plugin.file_not_granted` (404), `plugin.meeting_not_hosted` (404), `plugin.record_field_unknown`
  (422).

**Proposals.** `case.create` and `case.stage.move` join the kinds a plugin proposes (ADR-0084), and
open in Korsi's own forms through the Bridge's `openProposal`. A stage a `case.create` gives a key
keeps it: a slug matching `^[a-z][a-z0-9_]{1,39}$`, once in the list, which `case.stage.move` and
`getCase()`'s `stages` name. A stage without a key gets one from Korsi.

**Permissions.** `Caller.permissions` and `ToolCall.permissions` / `ActionCall.permissions` are the
plugin's own permissions the person holds (ADR-0082), by their bare keys. Korsi enforces them where
it shows the plugin's things; inside the plugin's routes the plugin does. A page's caller is reused
for `handleCacheSeconds` (60), so a revoke reaches the plugin that much later: set it lower where
that matters.

**Through Korsyar.** Korsyar's `korsi_meeting_get` gives a plugin a meeting without its words
(`transcript_withheld`) unless the plugin holds `meetings.transcript.read` and, for a restricted
meeting, hosts it; `korsi_analysis_text` needs `meetings.transcript.read` too.
