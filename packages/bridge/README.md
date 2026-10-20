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
