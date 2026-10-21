/**
 * The frame a plugin page sits in: connected to the Korsi around it (`KorsiProvider`) and drawn in
 * its look -- the MUI theme Korsi's palette, typeface and direction make, right to left through the
 * same emotion cache Korsi's shell uses, with Korsi's fonts loaded from Korsi itself. Every later
 * change Korsi sends (dark mode, another language) redraws it.
 *
 *     import { KorsiPage } from '@korsi/plugin-react/mui';
 *
 *     createRoot(root).render(
 *       <KorsiPage allowedOrigins={['https://*.korsi.ai']} iconComponent={Icon}>
 *         <App />
 *       </KorsiPage>
 *     );
 *
 * While it connects it shows a skeleton, and outside Korsi or when connecting failed it says so in
 * the person's language; each can be replaced.
 */
import { useMemo, type ReactNode } from 'react';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import rtlPlugin from '@mui/stylis-plugin-rtl';
import { prefixer } from 'stylis';

import Box from '@mui/material/Box';
import CssBaseline from '@mui/material/CssBaseline';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, ThemeProvider, type ThemeOptions } from '@mui/material/styles';

import { useMessages, type Messages } from './hooks.js';
import { KorsiIcons, type IconComponent } from './mui-parts.js';
import { createKorsiTheme } from './mui-theme.js';
import { KorsiProvider, useKorsiContext, type KorsiProviderProps } from './provider.js';

const caches = {
  rtl: createCache({ key: 'kp-rtl', stylisPlugins: [prefixer, rtlPlugin] }),
  ltr: createCache({ key: 'kp' }),
};

const FRAME_MESSAGES: Messages = {
  fa: {
    'outside.title': 'این صفحه داخل کرسی باز می‌شود',
    'outside.body': 'این افزونه را از لانچر کرسی باز کنید.',
    'failed.title': 'کرسی پاسخ نداد',
    'failed.body': 'صفحه را دوباره بار کنید، یا افزونه را دوباره از کرسی باز کنید.',
  },
  en: {
    'outside.title': 'This page opens inside Korsi',
    'outside.body': "Open this plugin from Korsi's launcher.",
    'failed.title': 'Korsi did not answer',
    'failed.body': 'Reload the page, or open the plugin again from Korsi.',
  },
  ar: {
    'outside.title': 'تُفتح هذه الصفحة داخل كرسي',
    'outside.body': 'افتح هذه الإضافة من مشغّل كرسي.',
    'failed.title': 'لم يستجب كرسي',
    'failed.body': 'أعد تحميل الصفحة، أو افتح الإضافة مرة أخرى من كرسي.',
  },
};

/** Solar's plug-circle, drawn here so the frame needs no icon of the page's. */
const PLUG =
  '<g fill="currentColor"><g opacity=".5"><path fill-rule="evenodd" d="M12.7497 22C17.9224 21.6161 22 17.2918 22 12.0139L22 12.0069L22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12L2 12.0069L2 12.0139C2 17.2918 6.07759 21.6161 11.2503 22L11.2503 21.9723C6.07986 21.5891 2.00357 17.2744 2 12.0069C2.00374 6.47961 6.47946 2 12 2C17.5205 2 21.9963 6.47961 22 12.0069C21.9964 17.2744 17.9201 21.5891 12.7497 21.9723L12.7497 22Z" clip-rule="evenodd"/><path d="M11.2503 21.9723C11.4978 21.9907 11.7478 22 12 22C12.2522 22 12.5022 21.9907 12.7497 21.9723C17.9201 21.5891 21.9964 17.2744 22 12.0069C21.9963 6.47961 17.5205 2 12 2C6.47946 2 2.00374 6.47961 2 12.0069C2.00357 17.2744 6.07986 21.5891 11.2503 21.9723Z"/></g><path d="M8.5 12.5147C8.5 14.1925 9.67737 15.595 11.2499 15.9389L11.2503 21.9724C11.4978 21.9908 11.7478 22.0001 12 22.0001C12.2522 22.0001 12.5022 21.9908 12.7497 21.9724L12.7499 15.9389C14.3226 15.5951 15.5 14.1926 15.5 12.5147V12.014C15.5 11.4609 15.0523 11.0126 14.5 11.0126H14.25V9.00983C14.25 8.59504 13.9142 8.25879 13.5 8.25879C13.0858 8.25879 12.75 8.59504 12.75 9.00983V11.0126H11.25V9.00983C11.25 8.59504 10.9142 8.25879 10.5 8.25879C10.0858 8.25879 9.75 8.59504 9.75 9.00983V11.0126H9.5C8.94772 11.0126 8.5 11.4609 8.5 12.014V12.5147Z"/></g>';

/** What the frame adds to Korsi's theme: a panel's own background, and Korsi's thin scrollbars. */
function frameTheme(panel: boolean): ThemeOptions {
  return {
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: panel ? { background: 'transparent' } : {},
          '*::-webkit-scrollbar': { width: 6, height: 6 },
          '*::-webkit-scrollbar-thumb': { borderRadius: 8, background: alpha('#919EAB', 0.32) },
        },
      },
    },
  };
}

function Themed({
  children,
  panel,
  theme: overrides,
}: {
  children: ReactNode;
  panel: boolean;
  theme: ThemeOptions | undefined;
}) {
  const context = useKorsiContext();
  const theme = useMemo(
    () => createKorsiTheme(context, frameTheme(panel), ...(overrides ? [overrides] : [])),
    [context, panel, overrides]
  );
  return (
    <CacheProvider value={theme.direction === 'rtl' ? caches.rtl : caches.ltr}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}

function Notice({ kind }: { kind: 'outside' | 'failed' }) {
  const t = useMessages(FRAME_MESSAGES);
  return (
    <Stack spacing={1.5} sx={{ p: 4, alignItems: 'center', textAlign: 'center' }}>
      <Box
        component="svg"
        viewBox="0 0 24 24"
        aria-hidden
        sx={{ width: 48, height: 48, color: 'text.disabled' }}
        dangerouslySetInnerHTML={{ __html: PLUG }}
      />
      <Typography variant="h6">{t(`${kind}.title`)}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t(`${kind}.body`)}
      </Typography>
    </Stack>
  );
}

function Connecting({ panel }: { panel: boolean }) {
  return (
    <Box sx={{ p: panel ? 1.5 : 3 }}>
      <Skeleton variant="rounded" height={panel ? 48 : 96} sx={{ mb: 2 }} />
      <Skeleton variant="rounded" height={panel ? 72 : 220} />
    </Box>
  );
}

export interface KorsiPageProps extends KorsiProviderProps {
  /**
   * A page Korsi shows inside one of its own (a desk or record panel): no background of its own,
   * and a smaller skeleton.
   */
  panel?: boolean;
  /** Draws the icons given by name to `Label`, `StatCard` and `EmptyState`. */
  iconComponent?: IconComponent;
  /** Merged over Korsi's theme. Keep it one object for the page's life: a new one redraws it. */
  theme?: ThemeOptions;
}

/** Connect to Korsi and draw `children` in its look. */
export function KorsiPage({
  children,
  panel = false,
  iconComponent,
  theme,
  connecting,
  outside,
  failed,
  ...connection
}: KorsiPageProps) {
  const frame = (content: ReactNode) => (
    <Themed panel={panel} theme={theme}>
      <KorsiIcons.Provider value={iconComponent ?? null}>{content}</KorsiIcons.Provider>
    </Themed>
  );
  return (
    <KorsiProvider
      {...connection}
      connecting={frame(connecting ?? <Connecting panel={panel} />)}
      outside={frame(outside ?? <Notice kind="outside" />)}
      failed={(error) =>
        frame(typeof failed === 'function' ? failed(error) : (failed ?? <Notice kind="failed" />))
      }
    >
      {frame(children)}
    </KorsiProvider>
  );
}
