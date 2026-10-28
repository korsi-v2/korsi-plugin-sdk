# korsi-plugin

The server side of a [Korsi](https://korsi.ai) plugin, in Python (3.11+, asyncio, `httpx`).

```python
from korsi_plugin import (
    SIGNATURE_HEADER,
    ActionContext,
    KorsiPlugin,
    RequestRejected,
    SQLiteEventLog,
    Topic,
)

plugin = KorsiPlugin(
    store,  # your InstallationStore
    events=SQLiteEventLog(data_dir / "plugin.db"),  # durable; in memory when left out
    trusted_api_bases=["https://*.korsi.ai/plugin/v1"],  # leave out only in a public catalogue
)

# POST /korsi/lifecycle -- installed is verified and confirmed with Korsi before it is kept;
# removed is believed only once Korsi refuses the stored credential.
result = await plugin.lifecycle(
    raw_body, headers.get(SIGNATURE_HEADER)
)  # {"status": result.status}


# POST /korsi/events -- verified, deduplicated, retried by Korsi if the handler raises; a second
# delivery while the first still runs is answered 503 (EventInProgress), so Korsi comes back.
async def on_event(installation, event):
    if event.topic == Topic.PROPOSAL_SETTLED:
        ...


status = await plugin.event(raw_body, headers.get(SIGNATURE_HEADER), on_event)

# POST /korsi/tools/{name} -- a read tool: read Korsi as the person the question is for.
installation, call = await plugin.tool_call(name, raw_body, headers.get(SIGNATURE_HEADER))
threads = await plugin.client(installation, call.handle).records("thread")


# POST /korsi/actions/{name} -- an action tool (ADR-0080): a change the person confirmed on a card
# the plugin's specialist prepared. Run once per change; refusing is an answer, not an error.
async def create_position(action: ActionContext):
    case_id = (action.call.earlier.get("case", {}).get("result") or {}).get("case_id")
    position = await positions.create(
        action.korsi, action.arguments, case_id, key=action.call.idempotency_key
    )
    return {
        "ok": True,
        "summary": said(action.call.locale, "position_created"),
        "records": [{"type": "position", "external_id": position.id}],
    }


plugin.register_action("create_position", create_position)
answer = await plugin.action_call(name, raw_body, headers.get(SIGNATURE_HEADER))  # answer it, 200

# Your pages' API -- the handle the Bridge gave the page, checked with Korsi (and cached).
who = await plugin.person(
    authorization=headers.get("authorization"), installation_id=headers.get("x-korsi-installation")
)
korsi = plugin.client(who.installation, who.handle)
if "see_compensation" in who.caller.permissions:  # the plugin's own permission (ADR-0082)
    ...

# Reserve before a service, settle after; a failure releases the hold.
async with korsi.reserve("pages.ocr", 10, idempotency_key=key, reference=doc_id) as hold:
    hold.use(len(await ocr(document)))


# Every refusal to answer the caller with: the status, and Korsi's code in the body.
def rejected(error: RequestRejected):
    return JSONResponse({"code": error.code, "detail": str(error)}, status_code=error.status)
```

Every refusal to answer the caller with is a `RequestRejected` carrying its HTTP `status`
(`SignatureInvalid` 401, `Unprovisioned` 409, `HandleRejected` 401/403, ...) and, where Korsi acts
on it, a `code`: one exception handler in your framework, which renders both. Korsi's own refusals
are `KorsiRefused` with a stable `code` (`Code.WALLET_INSUFFICIENT`, ...) and, for a spent budget or
a scan still being read, `retry_after`; Korsi not answering is `KorsiUnreachable`.

An `InstallationStore` is three async methods -- `installation(id)`, `save_installation(inst)`,
`remove_installation(id)`; keep the token and the signing secret encrypted. `SQLiteEventLog` is a
durable event log for a plugin with a disk and no database of its own. The manifest's types are in
`korsi_plugin.manifest` (`SpecialistSpec`, `ToolSpec` with its `kind`, `ExtensionPoint`).

## A plugin that keeps nothing

Every delivery -- an event, a tool or action call, a connection call, a page's call -- for an
installation the plugin has no credential for raises `Unprovisioned`: answer it **409 with
`{"code": "plugin.unprovisioned"}`** in the body. Korsi gives the credential again and asks once
more; a page's call goes through the Bridge, which does the same (ADR-0086). A 409 without the code
is the plugin's own refusal.

Korsi delivers at least once. The event log and the answers `action_call` remembers spare a repeat;
a plugin Korsi runs (`placement: instance`) has no disk, so after a restart only its records
remember. Make each change under a stable key there -- a record's external id, the action's
`idempotency_key` -- so a repeat finds it made. Korsi runs such a plugin with one way out, the
egress proxy in `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, which `httpx` follows as long as no
`transport` is given.

## Action tools

`register_action` names the handler for each manifest tool with `"kind": "action"`; `action_call`
verifies the signature, checks the body names the tool the path does, vouches for the person
(`action.caller`), runs the handler once per `action.call.idempotency_key` and cuts the answer to
Korsi's limits. `parse=` is the plugin's own check of the arguments; Korsi checked them against the
tool's `input_schema` already.

**When it arrives.** Korsi makes a card's changes in order and commits each before the next, so an
action call arrives only after the earlier changes on its card are committed: what they made is
there to read back through the plane. `action.call.earlier[<key>]["result"]` carries what each
earlier change made, such as the `case_id` of the case a `case.create` made; an earlier action's own
answer is its `summary` and `records`. `action.call.idempotency_key`, `<card_id>:<change_key>` from
`card_id` and `change_key`, is the same on every delivery: key the change by it in the plugin's
records and answer the same when it is already made. `action.call.arguments` may be the person's
edit -- the whole object as they saved it on the card, checked against the tool's `input_schema`
again, never a patch over what the specialist proposed.

**Korsyar's conversation is not the plugin's.** A specialist never holds Korsyar's session id:
Korsi runs it in a hidden session of its own, with the person's grant copied onto every request.
Korsi's MCP server refuses a plugin that passes `session_id`, on its own credential or on a person's
handle: a plugin reads as itself, or as the person its handle stands for, narrowed to its scopes.
Never ask for a `session_id` in a tool's `input_schema`.

## What the plane offers in plugin API 1.2

```python
await korsi.query_records(
    "application",
    {  # by the type's declared fields (ADR-0085)
        "where": [{"field": "stage", "op": "in", "value": ["screening", "interview"]}],
        "order_by": {"field": "received_at", "dir": "desc"},
    },
)
file = await korsi.file(file_id)  # a file a person handed it (files.read)
data = await korsi.file_content(file_id)  # or iter_file_content(), streamed
text = await korsi.file_text(file_id, wait=True)  # a scan: OCR at the publisher's cost, waited for
models = await korsi.models()  # models.use, a trusted scope (ADR-0081)
answer = await korsi.complete(
    {
        "model": models[0]["id"],
        "max_tokens": 800,
        "purpose": "cv_extract",
        "idempotency_key": f"cv:{file_id}:v1",
        "messages": [{"role": "user", "content": text["text"]}],
    }
)  # answer["content"], answer["usd_cost"] (an exact decimal string), answer["finish_reason"]
slots = await korsi.free_slots(
    {"user_ids": ids, "from": "2026-11-02", "to": "2026-11-13", "duration_minutes": 45}
)
meeting = await korsi.host_meeting(
    {
        "external_id": f"interview:{kit}",
        "title": title,
        "case_id": case_id,
        "participant_user_ids": interviewer_ids,  # members, you too when named
        "guests": [{"name": candidate_name}],  # no account: a name alone, which grants nothing
        "restricted": True,
        "recording": {"consent": "required", "audio_days": 30, "transcript_days": 180},
    }
)  # meetings.host
live = await korsi.live_transcript(meeting["id"], since=covered_through)  # meetings.live.read
case = await korsi.get_case(case_id)  # case["stages"]: [{key, name, position, current}]
```

The refusals to branch on are the Node SDK's (`packages/plugin/README.md`): `plugin.publisher_funds`
(402, `is_publisher_funds`), `plugin.model_not_allowed`, `plugin.rate_limited` with `retry_after`,
`plugin.text_pending` (`is_text_pending`, `text_pending_seconds`), `plugin.text_unavailable` with
`params["reason"]`, `plugin.file_not_granted`, `plugin.meeting_not_hosted` and
`plugin.record_field_unknown`. `complete()` asks again with the same `idempotency_key` when Korsi
did not answer (`retries`). A `case.create`'s own stage keys match `^[a-z][a-z0-9_]{1,39}$`, once
each. `Caller.permissions` is reused for `handle_cache_seconds` (60): set it lower where a revoke
must reach the plugin at once.

The sample plugin ([developers.korsi.ai/docs/example](https://developers.korsi.ai/docs/example))
uses all of it with FastAPI; the guide is at
[developers.korsi.ai/docs/guide](https://developers.korsi.ai/docs/guide). Installing it from GitHub
is in the [repository's README](../README.md#getting-it).
