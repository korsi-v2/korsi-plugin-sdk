/**
 * React for a Korsi plugin page. The MUI theme is a separate entry, `@korsi/plugin-react/mui`, so a
 * page without MUI does not need it.
 */
export {
  KorsiProvider,
  useHandle,
  useKorsi,
  useKorsiContext,
  useKorsiNavigation,
  usePluginApi,
  type KorsiProviderProps,
  type KorsiState,
  type KorsiStatus,
} from './provider.js';
