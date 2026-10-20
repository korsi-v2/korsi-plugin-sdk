# Korsi plugin SDKs

What a [Korsi](https://korsi.ai) plugin needs on both sides, so no publisher writes Korsi's
signature check, its lifecycle rules or its Bridge again — and gets one of them subtly wrong.

| Package | For | What it gives |
|---|---|---|
| [`korsi-plugin`](python) (Python) | the plugin's server | `KorsiPlugin`: the lifecycle, events (deduplicated), tool calls and a page's caller, each verified; `KorsiClient`, the plugin plane (`/plugin/v1`) typed from Korsi's OpenAPI; the wallet, exactly |
| [`@korsi/plugin`](packages/plugin) (Node, TypeScript) | the plugin's server | the same surface as `korsi-plugin` |
| [`@korsi/bridge`](packages/bridge) | the plugin's pages | the Bridge protocol (`korsi-bridge/1`) as types; finding the Korsi that frames the page and loading its runtime; calling the plugin's own server as the person |
| [`@korsi/plugin-ui`](packages/plugin-ui) | the plugin's pages, any framework | Korsi's theme as CSS variables; Korsi's typefaces; dates and digits as the organization writes them (Jalali, Persian digits) through `Intl`; `mountKorsiPage` |
| [`@korsi/plugin-react`](packages/plugin-react) | React pages | `KorsiProvider`, `useKorsi`, `useHandle`, `usePluginApi`; `createKorsiTheme` for MUI (`@korsi/plugin-react/mui`) |

The developer guide — Persian first, and English — is in Korsi's documentation
(`docs/plugins/README-fa.md`) and on the developer portal (`developers.korsi.ai`, *Guide*). The
sample plugin, [`korsi-plugin-email-commitments`](../korsi-plugin-email-commitments), is built on
`korsi-plugin`.

## Two rules the packages are built around

**The contract is Korsi's.** `openapi/plugin-v1.json` is a copy of the plugin plane's own document
(`/plugin/v1/openapi.json`, generated from the models Korsi validates with). Both SDKs' types *and
calls* are generated from it (`scripts/generate_models.py`): every route is a client method named
after the function Korsi serves it with -- `GET /cases` served by `list_cases` is `list_cases()` /
`listCases()`, and a page with `next_cursor` also gets `iter_cases()` / `iterCases()`. Only the
plane's first sixteen routes are wrapped by hand, in something better than the raw call
(`whoami()` reads ids, `consume()` takes an exact quantity, `record()` is `None` when missing); the
generator refuses to run if one of them disappears or a new name collides. A test in each SDK
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
`korsi-app` checkout beside this one and holds the types to it.

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

## Using it before it is published

Nothing here is on PyPI or npm yet. Until it is, depend on the checkout:

```toml
# pyproject.toml
dependencies = ["korsi-plugin"]

[tool.uv.sources]
korsi-plugin = { path = "../korsi-plugin-sdk/python" }
```

```bash
yarn add file:../korsi-plugin-sdk/packages/plugin   # after `yarn build` here
```

A container build needs the checkout as a second build context; the sample plugin's `Dockerfile`
shows how.
