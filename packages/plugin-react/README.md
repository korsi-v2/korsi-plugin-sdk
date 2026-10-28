# @korsi/plugin-react

React for a Korsi plugin page.

## In Korsi's look, with MUI

`KorsiPage` connects to the Korsi framing the page and draws it in Korsi's look: the MUI theme
Korsi's palette, typeface and direction make, right to left through the same emotion cache Korsi's
shell uses, with Korsi's fonts loaded from Korsi. Dark mode or another language redraws it. While
it connects it shows a skeleton; outside Korsi, or when Korsi did not answer, it says so in the
person's language.

```jsx
import { createRoot } from 'react-dom/client';
import { KorsiPage, Label, EmptyState } from '@korsi/plugin-react/mui';
import { useKorsiFormat, useMessages, usePluginData } from '@korsi/plugin-react';

createRoot(document.getElementById('root')).render(
  <KorsiPage allowedOrigins={['https://*.korsi.ai']} iconComponent={Icon}>
    <Inbox />
  </KorsiPage>
);

function Inbox() {
  const t = useMessages(MESSAGES); // { fa: {...}, en: {...}, ar: {...} }, following Korsi's language
  const format = useKorsiFormat(); // the person's calendar, time zone and digits
  const inbox = usePluginData('/api/messages'); // the plugin's server, as the person
  if (!inbox.data?.length) return <EmptyState icon="solar:inbox-line-bold-duotone" title={t('empty')} />;
  return inbox.data.map((m) => <Label key={m.id} color="success">{format.date(m.received_at)}</Label>);
}
```

- `panel` for a page Korsi shows inside one of its own (a desk or record panel): no background of
  its own.
- `iconComponent` draws the icons given by name to `Label`, `StatCard` and `EmptyState`: the
  page's own, registered offline (an Iconify component with a copied set, say). An element passed
  as `icon` is drawn as it is.
- `theme` is merged over Korsi's theme; `connecting`, `outside` and `failed` replace the frame's
  own views.

The theme is Korsi's own, not MUI's stock one with Korsi's colours: every MUI component a page
uses is drawn as it is in Korsi. Text fields in all three variants (their borders, focus and
disabled states, labels and helper text), selects and native selects with Korsi's arrow,
autocomplete, menus and popovers on Korsi's dropdown paper, dialogs, drawers and the backdrop,
tabs, tooltips, the rounded checkbox and radio, switch, slider, buttons, button groups, toggle
buttons and fabs, chips, alerts with Korsi's icons, tables, list items, skeletons, progress bars,
avatars and avatar groups, badges, pagination, stepper, accordion, links, breadcrumbs, rating,
cards and paper. Korsi's grey scale, its shadows and its hover and selection tints come with it,
in light and dark.

As in Korsi, `variant="soft"` (a colour's tint behind its darker shade) is a variant of `Button`,
`ButtonGroup`, `Chip` (a chip's default), `Pagination` and `Fab`, typed for TypeScript. Each
palette colour Korsi ships carries all its shades (`lighter` and `darker` beside `light` and
`dark`), and `background.neutral` is Korsi's grey well. A page's own `theme` is layered over
Korsi's, component by component: its style overrides apply after Korsi's, never in place of them.

The person's display settings come with it (`context.theme.display`, see `@korsi/bridge`): in the
compact view, Korsi's default, the spacing unit and the corners are 6px and the root font 15px, as
on the Korsi page around the frame, and high contrast gives cards Korsi's lighter shadow.
`theme.density` (`'compact'` or `'comfortable'`) is there for a measurement in neither unit.
Changing a setting in Korsi redraws the page, as dark mode does. MUI's own words -- an
autocomplete's "no options", pagination, an alert's close button -- follow the person's language
(Persian, Arabic). An older Korsi sends no display settings, and the page keeps MUI's 8px and 16px.

The pieces Korsi's own pages are made of: `Label` (the soft label), `StatCard`, `EmptyState`, and
`NameAvatar` (an initial on a gradient the name keeps). `createKorsiTheme(context, ...overrides)`
is the theme alone.

`KorsiPage` needs `@mui/material`, `@emotion/react`, `@emotion/cache`, `@mui/stylis-plugin-rtl`
and `stylis` beside it; the main entry needs none of them.

## Without MUI

```tsx
import { KorsiProvider, useKorsi, usePluginApi } from '@korsi/plugin-react';

<KorsiProvider allowedOrigins={['https://acme.korsi.ai']} outside={<p>Open me in Korsi.</p>}>
  <App />
</KorsiProvider>;

function App() {
  const api = usePluginApi(); // the plugin's own server, as the person
  const { bridge } = useKorsi(); // bridge.confirm(), bridge.pickPerson(), ...
}
```

`useKorsiContext`, `useHandle`, `useKorsiNavigation`, `useKorsiTitle`, `useKorsiFormat`,
`usePluginData`, `useMessages`, `usePickFile` and `useMeetingLive` work under either.

## Moving between screens

```tsx
import { useState } from 'react';
import { useKorsiNavigation, type KorsiMoveOptions } from '@korsi/plugin-react';

function App() {
  const [path, setPath] = useState('/');
  // Korsi's back, forward or a tab moved the address: draw that path.
  const move = useKorsiNavigation((next) => setPath(next));
  const go = (next: string, options?: KorsiMoveOptions) => {
    setPath(next);
    move(next, options);
  };
  // go('/deals/7')                  a new entry: back returns here
  // go('/deals', { replace: true }) no entry: a redirect, a corrected address
  // go('/deals/7', { back: true })  a form closed by its own button: back onto the screen before
}
```

`useKorsiNavigation(listener)` follows Korsi's address and returns the function that tells Korsi
the page moved, so its address follows (`navigate`, `korsi:navigate`). Each move is an entry in
Korsi's history, so its back button returns to the screen before -- arriving as `listener(path)` --
unless `{ replace: true }`. `{ back: true }` is for leaving a form or dialog by its own button:
Korsi steps its history back when the entry before is that path (the closed screen stays ahead),
else replaces, so back is never pressed once for nothing on a second copy of the same address.
It is sent with `replace`, so a Korsi older than `back` replaces. Korsi says nothing back for a
step it took: the page is already there.

## Naming the screen in Korsi's status bar

```tsx
import { useKorsiTitle } from '@korsi/plugin-react';

function Candidate({ application }) {
  // «رضا کاظمی» over the app's name in Korsi's status bar, while this screen is on.
  useKorsiTitle(application ? application.candidate_name : null);
}
```

`useKorsiTitle(title)` tells Korsi what the person is looking at on the app's page (`setTitle`,
`korsi:title`): it sets it while the component is mounted and whenever `title` changes, says it
again after every move -- Korsi's (back, a tab) or the page's own through `useKorsiNavigation` --
and clears it on unmount. Korsi lets a title go when the page moves to another screen and names
nothing new, so move with `useKorsiNavigation` rather than `bridge.navigate` for a component that
stays mounted across screens to keep its name. `null`, `undefined` or empty clears it, and the bar
names the app alone: pass null while the record loads. Plain text, cut to 120 characters by Korsi.
Use one per screen -- in the page, or in one place that knows the route; two mounted at once
overwrite each other in no set order. Only the installation's own app page is heard, never a
panel, and an older Korsi without `setTitle` ignores it.

## Korsi's file picker and the live room

```tsx
import { useMeetingLive, usePickFile, usePluginApi } from '@korsi/plugin-react';

function Upload() {
  const files = usePickFile(); // Korsi's own picker: «فایل‌های من», or an upload from the device
  const api = usePluginApi();
  if (!files.supported) return null; // an older Korsi: no picker to offer
  return (
    <button disabled={files.picking} onClick={async () => {
      const picked = await files.pick({ multiple: true, accept: ['application/pdf', '.docx'] });
      if (picked.length) await api.request('/api/intake', { method: 'POST', body: picked });
    }}>{t('upload')}</button>
  );
}

function InterviewPanel() {
  // In a `meeting.live.panel` frame: the room's state, clock and every line heard so far.
  const { supported, live } = useMeetingLive(() => reload()); // and a callback on each push
  return live && <Clock seconds={live.elapsed_seconds} state={live.state} lines={live.segments} />;
}
```

- `usePickFile()` is `{ supported, picking, pick(options) }`. The files picked are already handed to
  the installation, so the plugin's server reads them as the person or later as itself.
- `useMeetingLive(onPush?)` is `{ supported, live }`. Lines are kept by `id`; a name the room gives
  a voice later (`speaker_key`) goes on that voice's earlier lines too. The lines are the room's
  preview: the record is the transcript read from the recording afterwards.
- `useKorsi().bridge` has the rest: `showInKorsi({ kind, id })` to open a Korsi page (a meeting's
  page, a case), `openApp(path)` to open this plugin's own app from a panel, and `openProposal(id)`.
  Each is optional on an older Korsi: check before offering it.
