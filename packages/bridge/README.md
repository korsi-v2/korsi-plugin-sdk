# @korsi/bridge

Types and a loader for Korsi's Bridge (`korsi-bridge/1`): how a plugin's page, framed inside
Korsi's shell, talks to the Korsi around it.

```ts
import { connectKorsi, createPluginApi } from '@korsi/bridge';

const korsi = await connectKorsi({ allowedOrigins: ['https://acme.korsi.ai'] });
if (!korsi) {
  // Not inside Korsi: opened on its own, or framed by an origin this page does not trust.
} else {
  const { bridge, context } = korsi;       // context.theme, .locale, .dir, .user, .context ...
  bridge.onInit((next) => {/* the theme or the language changed */});
  if (await bridge.confirm({ title: 'Read this email?' })) {
    const api = createPluginApi(bridge);   // Authorization: Bearer <handle>, X-Korsi-Installation
    await api.request('/api/messages', { method: 'POST', body: email });
  }
}
```

`allowedOrigins` (exact origins, or patterns such as `https://*.korsi.ai`) -- or a `korsiOrigin`
your own server checked -- is required: loading the Bridge runs that origin's code in your page,
so the origin a page's address names is never believed on its own.

The runtime is not bundled: it is imported at run time from the Korsi framing the page
(`<korsi>/sdk/korsi-bridge.js`), so the page always speaks that Korsi's protocol. Allow it in the
page's `Content-Security-Policy` (`script-src <korsi origins>`), and send
`frame-ancestors <korsi origins>` so nobody else can frame the page.

## Korsi's theme in the context

`context.theme` is Korsi's look for the person, sent again whenever they change it: `mode`, the
`font_family` stack and the `palette` resolved for the mode, and `display`, their display settings
as the numbers Korsi draws its own page with -- `{ density: 'compact' | 'comfortable', spacing,
radius, font_size?, contrast: 'default' | 'high' }` (`KorsiDisplay`), in px. The compact view,
Korsi's default, is 6px spacing and corners on a 15px root; `contrast: 'high'` gives cards Korsi's
lighter `z1` shadow (its grey ground is already `palette.background`). A page drawn with them sits
flush with the Korsi around it, and `@korsi/plugin-react`'s `createKorsiTheme` applies them. An
older Korsi sends no `display`: draw at 8px and a 16px root there.

## What a page may ask

Every function in `BRIDGE_FUNCTIONS` is in every Korsi. Those in `OPTIONAL_BRIDGE_FUNCTIONS` came
later: check for each (`typeof bridge.pickFile === 'function'`) and offer what needs it only then,
so a page still works when an older Korsi frames it. Korsi draws every question; the page is told
the answer.

| Function | Message | What it does |
|---|---|---|
| `confirm`, `pickPerson`, `pickCase`, `askKorsyar`, `toast`, `navigate`, `resize` | `korsi:confirm` ... | Korsi's own dialogs, pickers, toast and address |
| `openProposal(id, { reject? })` | `korsi:open.proposal` | Opens one of the plugin's proposals in Korsi's own form, filled in: `action.create`, `case.create` (the new-case form), `case.stage.move` (the case's advance form), `case.change`, `calendar.event.create`, `decision.candidate`. Saving accepts it with the person's edits. Resolves `{ status, action_id, case_id, decision_id, error_code }`, or null when closed undecided |
| `pickFile({ multiple?, accept? })` | `korsi:pick.file` | Korsi's file picker: the person uploads into «فایل‌های من» or picks what they have (`files.read`). Korsi hands each file to the installation before answering `[{ file_id, name, size, media_type }]`; `[]` when they closed it. The plugin's server then reads `/plugin/v1/files/{id}`, `/content`, `/text` |
| `showInKorsi({ kind, id })` | `korsi:show` | Moves Korsi's shell to one of Korsi's pages: `meeting` (its page, with the button into the room), `case`, `decision`, `action`. The person's visibility applies as always |
| `openApp(path)` | `korsi:open.app` | Moves Korsi's shell to this installation's own app at `path` (relative to the app's root, starting with `/`) -- from a desk widget, a record or live panel, or the app. Never another installation's app |
| `onMeetingLive(listener)` | `korsi:meeting.live` (pushed) | For a `meeting.live.panel` frame of the installation hosting the meeting: `{ meeting_id, state: 'waiting' \| 'live' \| 'ended', elapsed_seconds, covered_through, segments: [{ id, speaker, speaker_key, speaker_user_id, text, at }] }` on every new batch of lines and every change of state. A listener added late is called at once with the latest state and every line so far; later calls carry only new or changed lines -- merge them by `id`. A page that reloads inside its frame is sent everything again. Returns an unsubscribe. A preview, never the record |
| `setTitle(title)` | `korsi:title` | What the person is looking at on the app's page -- a record's name, «مراحل استخدام · مدیر محصول». Korsi's status bar shows it over the app's name, as it names its own pages. Plain text, put on one line and cut to 120 characters; `null` or empty clears it and the bar names the app alone. Heard from the installation's own app page only, never a panel. Korsi lets it go when the page moves to another screen and names nothing new within a moment, and when the person leaves the app: say it again after each move (`useKorsiTitle` in `@korsi/plugin-react` does). The browser tab is not changed |
| `renewCredential()` | `korsi:credential.renew` | The plugin's server lost its credential (a restart with nothing kept, ADR-0086): Korsi shows «در حال آماده‌سازی» over the frame, gives the credential again, sends `korsi:init` with a new handle and resolves -- or rejects when the installation is no longer shown to the person |

`openProposal`, `pickFile`, `showInKorsi`, `openApp`, `onMeetingLive`, `renewCredential` and
`setTitle` are the optional ones. `showInKorsi` and `openApp` leave the frame behind, so nothing
comes back from them; nothing comes back from `setTitle` either.

`navigate(path)` is a history entry in Korsi unless `{ replace: true }` is set (for a redirect or a
corrected address): Korsi's and the browser's back button return to the screen before it, which
arrives as `onNavigate(path)`. Closing a form or dialog by its own button is a move back, not a
replace: `{ replace: true, back: true }` steps Korsi's history back when the entry before is `path`
(the closed screen stays ahead, as forward), else replaces. A replace there would leave the same
address twice in a row, and the next back press would stay on it -- Korsi tells the page nothing
for a step between two equal addresses. Nothing comes back for a step Korsi took; a Korsi older
than `back` reads only `replace`, and replaces. Move with the page's own router and never change
the frame's address.

## Calling the plugin's own server

`createPluginApi(bridge)` sends the person's live handle and the installation with every call, as
the server SDKs' `KorsiPlugin.person()` reads them. When the server answers **409 with
`{ "code": "plugin.unprovisioned" }`** -- it restarted with nothing kept -- it asks Korsi for the
credential again (`renewCredential`, once for every call waiting on it) and makes the call once
more. Only that code counts: a 409 without it is the plugin's own refusal and reaches the caller as
a `PluginApiError`. A refused renewal answers **403 `{ code: 'plugin.not_visible' }`**
(`NOT_VISIBLE`: the installation is no longer shown to the person); a wait that ran out answers the
server's 409, as the server may still be coming back. A call whose body is a stream is not made
twice; on a Korsi without `renewCredential` the server's answer goes to the caller.
