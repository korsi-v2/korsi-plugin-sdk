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

`useKorsiContext`, `useHandle`, `useKorsiNavigation`, `useKorsiFormat`, `usePluginData` and
`useMessages` work under either.
