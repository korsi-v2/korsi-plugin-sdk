# @korsi/plugin-react

React for a Korsi plugin page.

```tsx
import { KorsiProvider, useKorsi, useKorsiContext, usePluginApi } from '@korsi/plugin-react';
import { createKorsiTheme } from '@korsi/plugin-react/mui';
import { ThemeProvider } from '@mui/material/styles';

export default function Page() {
  return (
    <KorsiProvider allowedOrigins={['https://acme.korsi.ai']} outside={<p>Open me in Korsi.</p>}>
      <Themed />
    </KorsiProvider>
  );
}

function Themed() {
  const context = useKorsiContext();
  const theme = useMemo(() => createKorsiTheme(context), [context]);
  return <ThemeProvider theme={theme}><Messages /></ThemeProvider>;
}

function Messages() {
  const api = usePluginApi();       // the plugin's own server, as the person
  const { bridge } = useKorsi();    // bridge.confirm(), bridge.pickPerson(), ...
}
```

For right to left, give MUI an emotion cache with `stylis-plugin-rtl`, as Korsi's shell does;
`createKorsiTheme` sets `direction` from Korsi's context.
