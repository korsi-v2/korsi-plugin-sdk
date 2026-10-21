/**
 * A Korsi plugin page in MUI, in Korsi's look: the frame that connects and themes it (`KorsiPage`),
 * the theme alone (`createKorsiTheme`), and the pieces Korsi's own pages are made of.
 */
export { createKorsiTheme } from './mui-theme.js';
export { KorsiPage, type KorsiPageProps } from './mui-page.js';
export {
  EmptyState,
  Label,
  NameAvatar,
  StatCard,
  hueOf,
  initialOf,
  type EmptyStateProps,
  type IconComponent,
  type IconLike,
  type LabelColor,
  type LabelProps,
  type NameAvatarProps,
  type StatCardProps,
} from './mui-parts.js';
