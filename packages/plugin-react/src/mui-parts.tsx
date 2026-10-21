/**
 * The small pieces a page in Korsi's look is made of, drawn the way Korsi draws them: the soft
 * label, the stat card, the empty state, and the avatar a name keeps its colour on.
 *
 * Icons are the page's own: `KorsiPage`'s `iconComponent` draws an icon given by name (an Iconify
 * component with the page's registered set, say), so `icon="solar:letter-bold-duotone"` works on
 * every piece here; an element is drawn as it is.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, useTheme, type SxProps, type Theme } from '@mui/material/styles';

/** Draws an icon by name, at `width` pixels square. */
export type IconComponent = ComponentType<{ icon: string; width?: number; sx?: SxProps<Theme> }>;

/** An icon's name for the page's `iconComponent`, or an element drawn as it is. */
export type IconLike = string | ReactNode;

export const KorsiIcons = createContext<IconComponent | null>(null);

function PageIcon({ icon, width, sx }: { icon: IconLike; width: number; sx?: SxProps<Theme> }) {
  const Drawn = useContext(KorsiIcons);
  if (typeof icon !== 'string') return <>{icon}</>;
  return Drawn ? <Drawn icon={icon} width={width} {...(sx ? { sx } : {})} /> : null;
}

const asArray = (sx: SxProps<Theme> | undefined) => (Array.isArray(sx) ? sx : sx ? [sx] : []);

export type LabelColor =
  'default' | 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'error';

export interface LabelProps {
  color?: LabelColor;
  icon?: IconLike;
  children?: ReactNode;
  sx?: SxProps<Theme>;
}

/** Korsi's soft label: the colour's own tint behind its darker shade. */
export function Label({ color = 'default', icon, children, sx }: LabelProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const tone = color === 'default' ? null : theme.palette[color];
  return (
    <Box
      component="span"
      sx={[
        {
          px: 0.75,
          gap: 0.5,
          height: 24,
          minWidth: 24,
          lineHeight: 0,
          borderRadius: 0.75,
          cursor: 'default',
          alignItems: 'center',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          justifyContent: 'center',
          typography: 'caption',
          fontWeight: 700,
          color: tone ? (dark ? tone.light : tone.dark) : 'text.secondary',
          bgcolor: tone ? alpha(tone.main, 0.16) : alpha(theme.palette.grey[500], 0.16),
        },
        ...asArray(sx),
      ]}
    >
      {icon && <PageIcon icon={icon} width={14} />}
      {children}
    </Box>
  );
}

export interface StatCardProps {
  icon?: IconLike;
  color?: Exclude<LabelColor, 'default'>;
  value: ReactNode;
  label: ReactNode;
}

/** A number that matters, with what it counts and an icon in its colour. */
export function StatCard({ icon, color = 'primary', value, label }: StatCardProps) {
  const theme = useTheme();
  const main = theme.palette[color].main;
  return (
    <Card sx={{ p: 2.5, display: 'flex', gap: 2, alignItems: 'center' }}>
      {icon && (
        <Box
          sx={{
            width: 48,
            height: 48,
            flexShrink: 0,
            display: 'grid',
            borderRadius: 1.5,
            placeItems: 'center',
            color: main,
            bgcolor: alpha(main, 0.12),
          }}
        >
          <PageIcon icon={icon} width={26} />
        </Box>
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h4" sx={{ lineHeight: 1.2 }}>
          {value}
        </Typography>
        <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>
          {label}
        </Typography>
      </Box>
    </Card>
  );
}

export interface EmptyStateProps {
  icon?: IconLike;
  title?: ReactNode;
  body?: ReactNode;
  /** What makes something appear: a button, a link. */
  action?: ReactNode;
  /** Smaller, for a panel. */
  dense?: boolean;
}

/** Nothing here yet, said plainly, with what makes something appear. */
export function EmptyState({ icon, title, body, action, dense = false }: EmptyStateProps) {
  return (
    <Stack
      spacing={1}
      sx={{
        py: dense ? 3 : 6,
        px: 2,
        alignItems: 'center',
        textAlign: 'center',
        borderRadius: 2,
        border: (theme) => `dashed 1px ${theme.palette.divider}`,
      }}
    >
      {icon && <PageIcon icon={icon} width={dense ? 32 : 48} sx={{ color: 'text.disabled' }} />}
      {title && <Typography variant={dense ? 'subtitle2' : 'h6'}>{title}</Typography>}
      {body && (
        <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 480 }}>
          {body}
        </Typography>
      )}
      {action}
    </Stack>
  );
}

/** A hue that stays the same for the same name. */
export function hueOf(text: string | null | undefined): number {
  let sum = 0;
  for (const char of text ?? '') sum = (sum * 31 + char.charCodeAt(0)) % 360;
  return sum;
}

/** The first letter of a name, past the quotes and brackets a mail address wraps it in. */
export function initialOf(text: string | null | undefined): string {
  const letter = (text ?? '')
    .trim()
    .replace(/^["'<(]+/, '')
    .charAt(0);
  return letter ? letter.toUpperCase() : '?';
}

export interface NameAvatarProps {
  name: string | null | undefined;
  size?: number;
  sx?: SxProps<Theme>;
}

/** A person or a sender with no picture: their initial on a gradient their name keeps. */
export function NameAvatar({ name, size = 40, sx }: NameAvatarProps) {
  const hue = hueOf(name);
  return (
    <Avatar
      sx={[
        {
          width: size,
          height: size,
          fontWeight: 700,
          color: '#fff',
          fontSize: size * 0.42,
          background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${hue + 40} 62% 44%))`,
        },
        ...asArray(sx),
      ]}
    >
      {initialOf(name)}
    </Avatar>
  );
}
