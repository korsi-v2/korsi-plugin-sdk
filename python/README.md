# korsi-plugin

The server side of a [Korsi](https://korsi.ai) plugin, in Python (3.11+, asyncio, `httpx`).

```python
from korsi_plugin import KorsiPlugin, SIGNATURE_HEADER, SQLiteEventLog, Topic

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

# POST /korsi/tools/{name} -- read Korsi as the person the question is for.
installation, call = await plugin.tool_call(name, raw_body, headers.get(SIGNATURE_HEADER))
threads = await plugin.client(installation, call.handle).records("thread")

# Your pages' API -- the handle the Bridge gave the page, checked with Korsi (and cached).
who = await plugin.person(
    authorization=headers.get("authorization"), installation_id=headers.get("x-korsi-installation")
)
korsi = plugin.client(who.installation, who.handle)

# Reserve before a service, settle after; a failure releases the hold.
async with korsi.reserve("pages.ocr", 10, idempotency_key=key, reference=doc_id) as hold:
    hold.use(len(await ocr(document)))
```

Every refusal to answer the caller with is a `RequestRejected` carrying its HTTP `status`
(`SignatureInvalid` 401, `UnknownInstallation` 404, `HandleRejected` 401/403, ...): one exception
handler in your framework. Korsi's own refusals are `KorsiRefused` with a stable `code`
(`Code.WALLET_INSUFFICIENT`, ...) and, for a spent budget, `retry_after`; Korsi not answering is
`KorsiUnreachable`.

An `InstallationStore` is three async methods -- `installation(id)`, `save_installation(inst)`,
`remove_installation(id)`; keep the token and the signing secret encrypted. `SQLiteEventLog` is a
durable event log for a plugin without a database of its own.

The sample plugin ([developers.korsi.ai/docs/example](https://developers.korsi.ai/docs/example))
uses all of it with FastAPI; the guide is at
[developers.korsi.ai/docs/guide](https://developers.korsi.ai/docs/guide). Installing it from GitHub
is in the [repository's README](../README.md#getting-it).
