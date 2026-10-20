# @korsi/plugin-ui

Make a Korsi plugin page look and read like the Korsi around it -- no framework, no build step
required.

```ts
import { mountKorsiPage, formatDate, formatNumber } from '@korsi/plugin-ui';

const page = await mountKorsiPage({ allowedOrigins: ['https://acme.korsi.ai'] });
// The theme is on the document as CSS variables, and follows every change Korsi sends:
//   body { background: var(--k-bg); color: var(--k-text); font-family: var(--k-font); }
//   .button { background: var(--k-primary); color: var(--k-on-primary); }
// lang, dir, data-mode, data-calendar and data-numerals are set on <html>.

formatDate('2026-10-20', page?.context);   // '۲۸ مهر ۱۴۰۵' for a Jalali, Persian-digit organization
formatNumber(1234.5, page?.context);       // '۱٬۲۳۴٫۵'
```

The calendar and the digits are the organization's (`calendar_system`, `numerals`), the language
only names the months -- Korsi's own rule. Korsi's typefaces come from the Korsi framing the page
(`<korsi>/sdk/fonts/`); `mountKorsiPage` loads them, or call `loadKorsiFonts(origin)`. Allow them
with `font-src <korsi origins>`.

Variables: `--k-primary`, `--k-on-primary`, `--k-secondary`, `--k-success`, `--k-warning`,
`--k-error`, `--k-info`, `--k-bg`, `--k-paper`, `--k-text`, `--k-text-2`, `--k-divider`, `--k-font`.
