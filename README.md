# Korsi plugin SDKs

What a [Korsi](https://korsi.ai) plugin needs on both sides, so no publisher writes Korsi's
signature check, its lifecycle rules or its Bridge again — and gets one of them subtly wrong.

| Package | For | What it gives |
|---|---|---|
| [`korsi-plugin`](python) (Python) | the plugin's server | `KorsiPlugin`: the lifecycle, events (deduplicated; a person's mail events with a handle to read as them), tool calls, action calls (ADR-0080), connection calls (ADR-0067) and a page's caller, each verified, each answering `plugin.unprovisioned` for an installation it has no credential for (ADR-0086); `KorsiClient`, the plugin plane (`/plugin/v1`) typed from Korsi's OpenAPI -- record queries, handed files, Korsi's models, free slots, hosted meetings; the manifest's types; the wallet, exactly; `SQLiteEventLog` |
| [`@korsi/plugin`](packages/plugin) (Node, TypeScript) | the plugin's server | the same surface as `korsi-plugin`, through the egress proxy when one is set, but no durable event log of its own: bring an `EventLog` |
| [`@korsi/bridge`](packages/bridge) | the plugin's pages | the Bridge protocol (`korsi-bridge/1`) as types -- Korsi's forms for proposals, its file picker, showing a Korsi page or the plugin's own app, the live room's push; finding the Korsi that frames the page and loading its runtime; calling the plugin's own server as the person, its lost credential given again |
| [`@korsi/plugin-ui`](packages/plugin-ui) | the plugin's pages, any framework | Korsi's theme as CSS variables; Korsi's typefaces; dates and digits as the organization writes them (Jalali, Persian digits) through `Intl`; `mountKorsiPage` |
| [`@korsi/plugin-react`](packages/plugin-react) | React pages | `KorsiProvider`, `useKorsi`, `useHandle`, `usePluginApi`, `useKorsiFormat`, `usePluginData`, `useMessages`, `usePickFile`, `useMeetingLive`; in MUI (`@korsi/plugin-react/mui`) the page frame `KorsiPage`, `createKorsiTheme`, and `Label`, `StatCard`, `EmptyState`, `NameAvatar` |

The developer guide — Persian first, and English — is on the developer portal,
[developers.korsi.ai](https://developers.korsi.ai/docs/guide) (and in Korsi's own documentation,
`docs/plugins/README-fa.md`). The sample plugin, *email commitments*
([developers.korsi.ai/docs/example](https://developers.korsi.ai/docs/example)), is built on
`korsi-plugin` and `@korsi/plugin-react`.

## Getting it

Nothing here is on PyPI or npm yet; the SDK is this repository,
[github.com/korsi-v2/korsi-plugin-sdk](https://github.com/korsi-v2/korsi-plugin-sdk). Pin a commit
-- `main` moves with Korsi.

**Python** installs straight from GitHub:

```toml
# pyproject.toml
dependencies = ["korsi-plugin"]

[tool.uv.sources]
korsi-plugin = { git = "https://github.com/korsi-v2/korsi-plugin-sdk", subdirectory = "python", rev = "<commit>" }
```

```bash
pip install "korsi-plugin @ git+https://github.com/korsi-v2/korsi-plugin-sdk@<commit>#subdirectory=python"
```

**Node and pages** need a checkout beside your plugin, built once:

```bash
git clone https://github.com/korsi-v2/korsi-plugin-sdk.git
cd korsi-plugin-sdk && yarn install && yarn build && cd ..
yarn add file:./korsi-plugin-sdk/packages/plugin   # the server SDK; it depends on no other package here
```

A page compiles `@korsi/bridge`, `@korsi/plugin-ui` and `@korsi/plugin-react` from that checkout's
`src` -- they depend on one another, which `file:` cannot resolve -- with one alias per package in
its bundler; the sample plugin's `web/vite.config.js` is the whole of it:

```js
const sdk = path.resolve(here, '../korsi-plugin-sdk/packages');
resolve: {
  alias: [
    { find: '@korsi/plugin-react/mui', replacement: path.join(sdk, 'plugin-react/src/mui.ts') },
    { find: '@korsi/plugin-react', replacement: path.join(sdk, 'plugin-react/src/index.ts') },
    { find: '@korsi/plugin-ui', replacement: path.join(sdk, 'plugin-ui/src/index.ts') },
    { find: '@korsi/bridge', replacement: path.join(sdk, 'bridge/src/index.ts') },
  ],
  dedupe: ['react', 'react-dom', '@mui/material', '@emotion/react', '@emotion/cache'],
},
```

A container build of a server that depends on a checkout needs it as a second build context
(`docker build --build-context korsi-plugin-sdk=../korsi-plugin-sdk/python .`); one that installs
from GitHub needs nothing more.

Without a Korsi checkout beside this one, the Bridge's test against Korsi's own runtime is skipped;
point `KORSI_BRIDGE_RUNTIME` at a copy of any Korsi's `/sdk/korsi-bridge.js` to run it.

## Two rules the packages are built around

**The contract is Korsi's.** `openapi/plugin-v1.json` is a copy of the plugin plane's own document
(`/plugin/v1/openapi.json`, generated from the models Korsi validates with). Both SDKs' types *and
calls* are generated from it (`scripts/generate_models.py`): every route is a client method named
after the function Korsi serves it with -- `GET /cases` served by `list_cases` is `list_cases()` /
`listCases()`, and a page with `next_cursor` also gets `iter_cases()` / `iterCases()`. The routes in
the generator's `HAND_WRITTEN` are wrapped by hand, in something better than the raw call
(`whoami()` reads ids, `consume()` takes an exact quantity, `record()` is `None` when missing,
`complete()` asks again with the same key, `fileText()` can wait for a scan, `fileContent()`
streams); the generator refuses to run if one of them disappears or a new name collides. The
manifest's types come the same way from `openapi/korsi-plugin.schema.json`, Korsi's published schema
of `korsi-plugin.yaml` (`Manifest` in Node, `korsi_plugin.manifest` in Python). A test in each SDK
holds the clients to the document, and `openapi/testdata/org-api.patch.json` proves on a fixture
that new routes become methods that type-check and call Korsi correctly. When Korsi's plane changes:

```bash
scripts/sync-openapi.sh                        # from the korsi-api checkout beside this one
scripts/sync-openapi.sh https://acme.korsi.ai  # or from a running Korsi
```

**The Bridge's runtime is the Korsi's, not the package's.** `@korsi/bridge` carries types and a
loader; the runtime is imported at run time from the Korsi framing the page
(`<korsi>/sdk/korsi-bridge.js`), so a page always speaks the protocol of the Korsi it is in. The
same goes for the fonts (`<korsi>/sdk/fonts/`). A test imports Korsi's own runtime file from the
`korsi-app` checkout beside this one and holds the types to it. Functions a newer Korsi added are
in `OPTIONAL_BRIDGE_FUNCTIONS` -- `openProposal`, `pickFile`, `showInKorsi`, `openApp`,
`onMeetingLive`, `renewCredential`, `setTitle` -- and a page checks for each before offering what
needs it.

## Three rules a plugin Korsi runs lives by

A plugin released with `placement: instance` runs in Korsi's own container: no volume, a small
`/tmp`, and one way out -- the egress proxy named in `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`,
which both SDKs follow by themselves.

- **Answer a delivery you have no credential for `409 { "code": "plugin.unprovisioned" }`.** Every
  delivery kind raises `Unprovisioned` for it; render its `code` in the body. Korsi gives the
  credential again and asks once more, and a page's call does the same through the Bridge
  (ADR-0086). A 409 without the code is the plugin's own refusal.
- **Handle everything at least once.** The SDKs' in-memory logs spare a repeat while the process
  lives; after a restart only the plugin's records remember, so key each change there.
- **Keep nothing on disk.** Installations live in memory, everything durable in the plugin's
  records.

## Working on it

```bash
# Python
cd python && uv sync
uv run pytest && uv run ruff check . && uv run ruff format --check . && uv run mypy

# Node and the browser packages
yarn install
yarn verify   # generated types current, prettier, tsc (build and tests), vitest
yarn build    # dist/ for every package
```

Node 20.19 or later; Python 3.11 or later (3.13 in development, as in the rest of Korsi).

**This SDK is kept current with Korsi.** A Korsi change to anything a plugin talks to -- the plugin
plane (`/plugin/v1`), the connection calls, the lifecycle, event or tool-call deliveries, the
Bridge's runtime, or the theme and typefaces Korsi sends a page -- updates this repository in the
same piece of work: `scripts/sync-openapi.sh`, the hand-written surface if it needs it, both SDKs'
tests, and the developer portal's guide where it describes the SDK (Korsi's definition of done,
item 12).
