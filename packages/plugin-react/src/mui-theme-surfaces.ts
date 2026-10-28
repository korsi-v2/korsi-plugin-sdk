/**
 * Korsi's look for MUI's surfaces and data display, ported from Korsi's theme
 * (`korsi-app/src/theme/core/components`): paper, card, dialog, drawer, backdrop, tooltip, tabs,
 * alert, chip, table, list, skeleton, progress, avatar, badge, pagination, stepper, accordion,
 * link, breadcrumbs, rating, and the page's own baseline.
 */
import { accordionClasses } from '@mui/material/Accordion';
import { accordionDetailsClasses } from '@mui/material/AccordionDetails';
import { accordionSummaryClasses } from '@mui/material/AccordionSummary';
import { alertClasses } from '@mui/material/Alert';
import { chipClasses } from '@mui/material/Chip';
import { linearProgressClasses } from '@mui/material/LinearProgress';
import { paginationItemClasses } from '@mui/material/PaginationItem';
import { tabClasses } from '@mui/material/Tab';
import { tableCellClasses } from '@mui/material/TableCell';
import { tableRowClasses } from '@mui/material/TableRow';
import type { Theme } from '@mui/material/styles';

import {
  ACCORDION_EXPAND_ICON,
  ACCORDION_ICON,
  ALERT_ICONS,
  CHIP_DELETE_ICON,
  RATING_ICON,
  renderSurplus,
} from './mui-theme-icons.js';
import {
  COLOR_KEYS,
  fade,
  filledStyles,
  isDark,
  neutralOf,
  paperStyles,
  radius,
  shadesOf,
  shadowsOf,
  sharedOf,
  softStyles,
  type ComponentThemes,
  type Css,
  type StyleArgs,
  type Variant,
} from './mui-theme-tokens.js';

const is =
  (match: (props: StyleArgs) => boolean) =>
  (props: StyleArgs): boolean =>
    match(props);

/* -------------------------------------------------------------------------------------------- *
 * Paper, card, dialog, drawer, backdrop, tooltip
 * -------------------------------------------------------------------------------------------- */

const surfaces: ComponentThemes = {
  // A calm, neutral canvas: the page's own background, never an image.
  MuiCssBaseline: {
    styleOverrides: {
      body: { backgroundImage: 'none' },
    },
  },
  MuiPaper: {
    defaultProps: { elevation: 0 },
    styleOverrides: {
      root: {
        backgroundImage: 'none',
        variants: [
          {
            props: { variant: 'outlined' },
            style: ({ theme }) => ({ borderColor: sharedOf(theme).paperOutlined }),
          },
        ],
      },
    },
  },
  MuiCard: {
    styleOverrides: {
      root: ({ theme }) => ({
        position: 'relative',
        boxShadow: `var(--card-shadow, ${shadowsOf(theme).card})`,
        borderRadius: `var(--card-radius, ${radius(theme, 2)}px)`,
        zIndex: 0, // Safari: `overflow: hidden` with a radius
      }),
    },
  },
  MuiCardHeader: {
    defaultProps: {
      slotProps: { title: { variant: 'h6' }, subheader: { variant: 'body2', sx: { mt: '4px' } } },
    },
    styleOverrides: { root: ({ theme }) => ({ padding: theme.spacing(3, 3, 0) }) },
  },
  MuiCardContent: {
    styleOverrides: { root: ({ theme }) => ({ padding: theme.spacing(3) }) },
  },
  MuiDialog: {
    styleOverrides: {
      paper: {
        variants: [
          {
            props: is((props) => !props.fullScreen),
            style: ({ theme }) => ({
              margin: theme.spacing(2),
              boxShadow: shadowsOf(theme).dialog,
              borderRadius: radius(theme, 2),
            }),
          },
        ],
      },
    },
  },
  MuiDialogTitle: {
    styleOverrides: { root: ({ theme }) => ({ padding: theme.spacing(3) }) },
  },
  MuiDialogContent: {
    styleOverrides: {
      root: ({ theme }) => ({ padding: theme.spacing(0, 3) }),
      dividers: ({ theme }) => ({
        borderTop: 0,
        borderBottomStyle: 'dashed',
        paddingBottom: theme.spacing(3),
      }),
    },
  },
  MuiDialogActions: {
    defaultProps: { disableSpacing: true },
    styleOverrides: {
      root: ({ theme }) => ({
        padding: theme.spacing(3),
        '& > :not(:first-of-type)': { marginLeft: theme.spacing(1.5) },
      }),
    },
  },
  MuiDrawer: {
    styleOverrides: {
      paper: {
        variants: [
          {
            props: { variant: 'temporary', anchor: 'left' },
            style: ({ theme }) => ({
              ...paperStyles(theme),
              boxShadow: shadowsOf(theme).drawer(1),
            }),
          },
          {
            props: { variant: 'temporary', anchor: 'right' },
            style: ({ theme }) => ({
              ...paperStyles(theme),
              boxShadow: shadowsOf(theme).drawer(-1),
            }),
          },
        ],
      },
    },
  },
  MuiBackdrop: {
    styleOverrides: {
      root: ({ theme }) => ({
        variants: [
          {
            props: is((props) => !props.invisible),
            style: { backgroundColor: fade(theme.palette.grey[800], 0.48) },
          },
        ],
      }),
    },
  },
  MuiTooltip: {
    defaultProps: {
      slotProps: { popper: { modifiers: [{ name: 'offset', options: { offset: [0, -4] } }] } },
    },
    styleOverrides: {
      tooltip: ({ theme }) => ({
        borderRadius: radius(theme, 0.75),
        backgroundColor: isDark(theme) ? theme.palette.grey[700] : theme.palette.grey[800],
      }),
      arrow: ({ theme }) => ({
        color: isDark(theme) ? theme.palette.grey[700] : theme.palette.grey[800],
      }),
    },
  },
  MuiAppBar: {
    defaultProps: { color: 'transparent' },
    styleOverrides: { root: { boxShadow: 'none' } },
  },
  MuiStack: { defaultProps: { useFlexGap: true } },
  MuiSvgIcon: {
    styleOverrides: { fontSizeLarge: { width: 32, height: 32, fontSize: 'inherit' } },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Tabs
 * -------------------------------------------------------------------------------------------- */

/** `indicatorColor="custom"`: a segmented strip, the selected tab raised on a pill. */
function segmentedTabs(theme: Theme): Css {
  return {
    '--item-padding-x': '16px',
    '--list-padding-x': '8px',
    '--indicator-radius': '8px',
    '--indicator-shadow': shadowsOf(theme).z1,
    '--indicator-bg': isDark(theme) ? theme.palette.grey[900] : theme.palette.common.white,
    backgroundColor: neutralOf(theme),
    [`& .${tabClasses.root}`]: {
      zIndex: 1,
      minHeight: 52,
      paddingLeft: 'var(--item-padding-x)',
      paddingRight: 'var(--item-padding-x)',
    },
  };
}

const tabs: ComponentThemes = {
  MuiTabs: {
    defaultProps: {
      variant: 'scrollable',
      textColor: 'inherit',
      indicatorColor: 'inherit',
      allowScrollButtonsMobile: true,
    },
    styleOverrides: {
      root: {
        variants: [
          {
            props: { textColor: 'inherit' },
            style: {
              [`& .${tabClasses.root}`]: { [`&.${tabClasses.selected}`]: { color: 'inherit' } },
            },
          },
          { props: { indicatorColor: 'custom' }, style: ({ theme }) => segmentedTabs(theme) },
        ],
      },
      list: {
        variants: [
          {
            props: is(
              (props) =>
                props.indicatorColor !== 'custom' &&
                props.variant !== 'fullWidth' &&
                props.orientation !== 'vertical'
            ),
            style: ({ theme }) => ({
              gap: theme.spacing(5),
              [theme.breakpoints.down('sm')]: { gap: theme.spacing(3) },
            }),
          },
          {
            props: { indicatorColor: 'custom', orientation: 'horizontal' },
            style: {
              height: '100%',
              paddingLeft: 'var(--list-padding-x)',
              paddingRight: 'var(--list-padding-x)',
            },
          },
          {
            props: { indicatorColor: 'custom', orientation: 'vertical' },
            style: { paddingTop: 'var(--list-padding-x)', paddingBottom: 'var(--list-padding-x)' },
          },
        ],
      },
      indicator: {
        variants: [
          { props: { indicatorColor: 'inherit' }, style: { backgroundColor: 'currentColor' } },
          {
            props: { indicatorColor: 'custom' },
            style: {
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'transparent',
              '&::before': {
                content: '""',
                width: '100%',
                boxShadow: 'var(--indicator-shadow)',
                backgroundColor: 'var(--indicator-bg)',
                borderRadius: 'var(--indicator-radius)',
                height: 'calc(100% - calc(var(--list-padding-x) * 2))',
              },
            },
          },
          {
            props: { indicatorColor: 'custom', orientation: 'vertical' },
            style: {
              width: '100%',
              '&::before': {
                height: '100%',
                width: 'calc(100% - calc(var(--list-padding-x) * 2))',
              },
            },
          },
        ],
      },
    },
  },
  MuiTab: {
    defaultProps: { disableRipple: true, iconPosition: 'start' },
    styleOverrides: {
      root: ({ theme }) => ({
        opacity: 1,
        minWidth: 48,
        paddingLeft: 0,
        paddingRight: 0,
        color: theme.palette.text.secondary,
        fontWeight: theme.typography.fontWeightMedium,
        lineHeight: theme.typography.body2.lineHeight,
        variants: [
          { props: {}, style: { [`&.${tabClasses.selected}`]: { fontWeight: 600 } } },
          { props: is((props) => !!props.icon && !!props.label), style: { minHeight: 'auto' } },
        ],
      }),
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Alert, chip, badge, avatar
 * -------------------------------------------------------------------------------------------- */

const SEVERITIES = ['info', 'success', 'warning', 'error'] as const;

/** On a dark page a standard or outlined alert's icon is its colour's light shade. */
const darkIcon = (theme: Theme, key: (typeof SEVERITIES)[number]): Css =>
  isDark(theme) ? { [`& .${alertClasses.icon}`]: { color: theme.palette[key].light } } : {};

const alertVariants: Variant[] = SEVERITIES.flatMap((key): Variant[] => [
  {
    props: { variant: 'standard', severity: key },
    style: ({ theme }) => {
      const { lighter, darker } = shadesOf(theme, key);
      return {
        ...(isDark(theme)
          ? { color: lighter, backgroundColor: darker }
          : { color: darker, backgroundColor: lighter }),
        ...darkIcon(theme, key),
      };
    },
  },
  {
    props: { variant: 'filled', severity: key },
    style: ({ theme }) => ({ color: theme.palette[key].contrastText }),
  },
  {
    props: { variant: 'outlined', severity: key },
    style: ({ theme }) => {
      const color = theme.palette[key];
      return {
        color: isDark(theme) ? color.light : color.dark,
        backgroundColor: fade(color.main, 0.08),
        border: `solid 1px ${fade(color.main, 0.16)}`,
        ...darkIcon(theme, key),
      };
    },
  },
]);

const chipColors = ['default', ...COLOR_KEYS] as const;

const chipVariants: Variant[] = [
  {
    props: { variant: 'filled', color: 'default' },
    style: ({ theme }) => ({
      ...filledStyles(theme, 'inherit'),
      [`&.${chipClasses.clickable}`]: filledStyles(theme, 'inherit', true),
    }),
  },
  { props: { variant: 'outlined' }, style: { borderColor: 'currentColor' } },
  {
    props: { variant: 'outlined', color: 'default' },
    style: ({ theme }) => ({ borderColor: sharedOf(theme).buttonOutlined }),
  },
  ...chipColors.map((key): Variant => ({
    props: { variant: 'soft', color: key },
    style: ({ theme }) => {
      const tone = key === 'default' ? 'inherit' : key;
      return {
        ...softStyles(theme, tone),
        [`&.${chipClasses.clickable}`]: softStyles(theme, tone, true),
      };
    },
  })),
  { props: { size: 'small' }, style: { borderRadius: '8px' } },
  { props: { size: 'medium' }, style: { borderRadius: '10px' } },
  {
    props: {},
    style: ({ theme }) => {
      const { action } = theme.palette;
      return {
        [`&.${chipClasses.disabled}`]: {
          opacity: 1,
          color: action.disabled,
          [`&:not(.${chipClasses.outlined})`]: { backgroundColor: action.disabledBackground },
          [`&.${chipClasses.outlined}`]: { borderColor: action.disabledBackground },
          [`& .${chipClasses.avatar}`]: {
            color: action.disabled,
            backgroundColor: action.disabledBackground,
            '& img': { opacity: action.disabledOpacity },
          },
        },
      };
    },
  },
];

const STATUSES = ['online', 'always', 'busy', 'offline'];

const badgeVariants: Variant[] = [
  { props: { color: 'default' }, style: ({ theme }) => filledStyles(theme, 'default') },
  {
    props: is((props) => STATUSES.includes(String(props.variant))),
    style: ({ theme }) => ({
      width: 10,
      height: 10,
      padding: 0,
      top: 'auto',
      right: '14%',
      bottom: '14%',
      minWidth: 'auto',
      transform: 'scale(1) translate(50%, 50%)',
      '&::before, &::after': {
        content: "''",
        borderRadius: 1,
        backgroundColor: theme.palette.common.white,
      },
    }),
  },
  {
    props: { variant: 'online' },
    style: ({ theme }) => ({ backgroundColor: theme.palette.success.main }),
  },
  {
    props: { variant: 'always' },
    style: ({ theme }) => ({
      backgroundColor: theme.palette.warning.main,
      '&::before': { width: 2, height: 4, transform: 'translate(1px, -1px)' },
      '&::after': { width: 2, height: 4, transform: 'translate(0, 1px) rotate(125deg)' },
    }),
  },
  {
    props: { variant: 'busy' },
    style: ({ theme }) => ({
      backgroundColor: theme.palette.error.main,
      '&::before': { width: 6, height: 2 },
    }),
  },
  {
    props: { variant: 'offline' },
    style: ({ theme }) => ({
      backgroundColor: theme.palette.text.disabled,
      '&::before': { width: 6, height: 6, borderRadius: '50%' },
    }),
  },
  { props: { variant: 'invisible' }, style: { display: 'none' } },
];

const AVATAR_COLORS = ['default', 'inherit', ...COLOR_KEYS] as const;

/** The colour an avatar without a picture takes from its `alt`'s first Latin letter. */
function avatarColorOf(alt: unknown): (typeof AVATAR_COLORS)[number] {
  const first = typeof alt === 'string' ? alt.trim().charAt(0).toLowerCase() : '';
  if (!/[a-z]/.test(first)) return 'default';
  return AVATAR_COLORS[(first.charCodeAt(0) - 97) % AVATAR_COLORS.length] ?? 'default';
}

const avatarVariants: Variant[] = [
  {
    props: {},
    style: ({ theme }) => ({
      color: theme.palette.action.active,
      backgroundColor: isDark(theme) ? theme.palette.grey[700] : theme.palette.grey[300],
    }),
  },
  {
    props: is((props) => props.color === 'inherit' || avatarColorOf(props.alt) === 'inherit'),
    style: ({ theme }) => filledStyles(theme, 'inherit'),
  },
  ...COLOR_KEYS.map((key): Variant => ({
    props: is((props) => props.color === key || avatarColorOf(props.alt) === key),
    style: ({ theme }) => ({
      color: theme.palette[key].contrastText,
      backgroundColor: theme.palette[key].main,
    }),
  })),
];

const display: ComponentThemes = {
  MuiAlert: {
    defaultProps: { iconMapping: ALERT_ICONS },
    styleOverrides: {
      root: { variants: alertVariants },
      icon: { opacity: 1 },
    },
  },
  MuiAlertTitle: {
    styleOverrides: {
      root: ({ theme }) => ({ marginBottom: theme.spacing(0.5), fontWeight: 600 }),
    },
  },
  MuiChip: {
    defaultProps: { deleteIcon: CHIP_DELETE_ICON, variant: 'soft' },
    styleOverrides: {
      root: { variants: chipVariants },
      label: ({ theme }) => ({ fontWeight: theme.typography.fontWeightMedium }),
      avatar: {
        variants: COLOR_KEYS.map((key): Variant => ({
          props: { color: key },
          style: ({ theme }) => ({
            color: shadesOf(theme, key).lighter,
            backgroundColor: theme.palette[key].dark,
          }),
        })),
      },
      icon: { color: 'currentColor' },
      deleteIcon: {
        opacity: 0.48,
        color: 'currentColor',
        '&:hover': { opacity: 0.8, color: 'currentColor' },
      },
    },
  },
  MuiBadge: {
    styleOverrides: { dot: { borderRadius: '50%' }, badge: { variants: badgeVariants } },
  },
  MuiAvatar: {
    styleOverrides: {
      root: ({ theme }) => ({
        containerType: 'inline-size',
        fontSize: theme.typography.pxToRem(18),
        fontWeight: theme.typography.fontWeightMedium,
      }),
      colorDefault: { variants: avatarVariants },
      rounded: ({ theme }) => ({ borderRadius: radius(theme, 1.5) }),
    },
  },
  MuiAvatarGroup: {
    defaultProps: { max: 4, renderSurplus },
    styleOverrides: {
      root: {
        justifyContent: 'flex-end',
        variants: [
          {
            props: { variant: 'compact' },
            style: { width: 40, height: 40, position: 'relative' },
          },
        ],
      },
      avatar: {
        variants: [
          {
            props: { variant: 'compact' },
            style: {
              margin: 0,
              width: 28,
              height: 28,
              position: 'absolute',
              '&:first-of-type': { left: 0, bottom: 0, zIndex: 9 },
              '&:last-of-type': { top: 0, right: 0 },
            },
          },
        ],
      },
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Table, list, skeleton, progress
 * -------------------------------------------------------------------------------------------- */

const PROGRESS_COLORS = ['inherit', ...COLOR_KEYS] as const;
const TRACK = 0.24;
const DASHED = 0.48;

const progressVariants: Variant[] = PROGRESS_COLORS.flatMap((key): Variant[] => [
  {
    props: is((props) => props.color === key && props.variant !== 'buffer'),
    style: ({ theme }) =>
      key === 'inherit'
        ? { '&::before': { opacity: TRACK }, [`& .${linearProgressClasses.bar2}`]: { opacity: 1 } }
        : { backgroundColor: fade(theme.palette[key].main, TRACK) },
  },
  {
    props: is((props) => props.color === key && props.variant === 'buffer'),
    style: ({ theme }) => {
      const ink = key === 'inherit' ? 'currentColor' : theme.palette[key].main;
      const dot = fade(ink, DASHED);
      return {
        [`& .${linearProgressClasses.bar2}`]: {
          backgroundColor: key === 'inherit' ? 'currentColor' : fade(ink, TRACK),
          ...(key === 'inherit' && { opacity: TRACK }),
        },
        [`& .${linearProgressClasses.dashed}`]: {
          backgroundImage: `radial-gradient(${dot} 0%, ${dot} 16%, transparent 42%)`,
        },
      };
    },
  },
]);

const data: ComponentThemes = {
  MuiTableContainer: {
    styleOverrides: {
      root: ({ theme }) => ({
        position: 'relative',
        scrollbarWidth: 'thin',
        scrollbarColor: `${fade(theme.palette.text.disabled, 0.4)} ${fade(theme.palette.text.disabled, 0.08)}`,
      }),
    },
  },
  MuiTableRow: {
    styleOverrides: {
      root: ({ theme }) => ({
        [`&.${tableRowClasses.selected}`]: {
          backgroundColor: fade(theme.palette.primary.dark, 0.04),
          '&:hover': { backgroundColor: fade(theme.palette.primary.dark, 0.08) },
        },
        '&:last-of-type': { [`& .${tableCellClasses.root}`]: { border: 0 } },
      }),
    },
  },
  MuiTableCell: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderBottomStyle: 'dashed',
        borderBottomColor: fade(theme.palette.grey[500], 0.2),
      }),
      head: ({ theme }) => ({
        fontSize: theme.typography.pxToRem(14),
        color: theme.palette.text.secondary,
        fontWeight: 600,
        backgroundColor: neutralOf(theme),
      }),
      stickyHeader: ({ theme }) => ({
        backgroundColor: theme.palette.background.paper,
        backgroundImage: `linear-gradient(to bottom, ${neutralOf(theme)}, ${neutralOf(theme)})`,
      }),
      paddingCheckbox: ({ theme }) => ({ paddingLeft: theme.spacing(1) }),
    },
  },
  MuiTablePagination: {
    defaultProps: {
      slotProps: {
        actions: { previousButton: { size: 'small' }, nextButton: { size: 'small' } },
        select: { name: 'table-pagination-select' },
      },
    },
    styleOverrides: {
      root: { width: '100%' },
      toolbar: { height: 64 },
      actions: { marginRight: 8 },
      select: { display: 'flex', alignItems: 'center' },
      selectIcon: { right: 4, width: 16, height: 16, top: 'calc(50% - 8px)' },
    },
  },
  MuiListItemIcon: {
    styleOverrides: {
      root: ({ theme }) => ({ color: 'inherit', minWidth: 'auto', marginRight: theme.spacing(2) }),
    },
  },
  MuiListItemAvatar: {
    styleOverrides: {
      root: ({ theme }) => ({ minWidth: 'auto', marginRight: theme.spacing(2) }),
    },
  },
  MuiListItemText: {
    defaultProps: {
      slotProps: { primary: { typography: 'subtitle2' }, secondary: { component: 'span' } },
    },
    styleOverrides: { root: { margin: 0 }, multiline: { margin: 0 } },
  },
  MuiSkeleton: {
    defaultProps: { animation: 'wave', variant: 'rounded' },
    styleOverrides: {
      root: ({ theme }) => ({ backgroundColor: fade(theme.palette.grey[400], 0.12) }),
      rounded: ({ theme }) => ({ borderRadius: radius(theme, 2) }),
    },
  },
  MuiCircularProgress: { defaultProps: { color: 'inherit' } },
  MuiLinearProgress: {
    defaultProps: { color: 'inherit' },
    styleOverrides: {
      root: { borderRadius: 16, variants: progressVariants },
      bar: { borderRadius: 'inherit' },
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Pagination, stepper, accordion, link, breadcrumbs, rating
 * -------------------------------------------------------------------------------------------- */

const paginationVariants: Variant[] = [
  {
    props: { variant: 'text', color: 'standard' },
    style: ({ theme }) => ({
      [`&.${paginationItemClasses.selected}`]: filledStyles(theme, 'inherit', true),
    }),
  },
  {
    props: { variant: 'outlined' },
    style: ({ theme }) => {
      const opacity = theme.palette.action.selectedOpacity;
      return {
        borderColor: sharedOf(theme).buttonOutlined,
        [`&.${paginationItemClasses.selected}`]: {
          borderColor: 'currentColor',
          backgroundColor: fade('currentColor', opacity),
          '&:hover': { backgroundColor: fade('currentColor', opacity * 2) },
        },
      };
    },
  },
  {
    props: { variant: 'outlined', color: 'standard' },
    style: ({ theme }) => ({
      [`&.${paginationItemClasses.selected}`]: {
        backgroundColor: fade(theme.palette.grey[500], 0.08),
        '&:hover': { backgroundColor: fade(theme.palette.grey[500], 0.16) },
      },
    }),
  },
  ...(['standard', ...COLOR_KEYS] as const).map((key): Variant => ({
    props: { variant: 'soft', color: key },
    style: ({ theme }) => ({
      [`&.${paginationItemClasses.selected}`]: softStyles(
        theme,
        key === 'standard' ? 'inherit' : key,
        true
      ),
    }),
  })),
  {
    props: {},
    style: ({ theme }) => ({
      [`&.${paginationItemClasses.disabled}`]: {
        [`&.${paginationItemClasses.selected}`]: {
          backgroundColor: theme.palette.action.disabledBackground,
        },
      },
    }),
  },
];

/** The accordion's plus turning into a minus as it opens. */
function expandIconStyles(theme: Theme): Css {
  const icon: Css = {
    width: 18,
    height: 18,
    position: 'absolute',
    transition: theme.transitions.create(['transform', 'opacity'], {
      easing: theme.transitions.easing.easeIn,
      duration: theme.transitions.duration.shortest,
    }),
  };
  return {
    [`& .${ACCORDION_ICON.container}`]: {
      transition: 'inherit',
      transform: 'rotate(0deg)',
      width: 24,
      height: 24,
      display: 'flex',
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    [`& .${ACCORDION_ICON.plus}`]: { ...icon, transform: 'scale(1)', opacity: 1 },
    [`& .${ACCORDION_ICON.minus}`]: { ...icon, transform: 'scale(0.4)', opacity: 0 },
    [`&.${accordionSummaryClasses.expanded}`]: {
      [`& .${ACCORDION_ICON.container}`]: { transform: 'rotate(-180deg)' },
      [`& .${ACCORDION_ICON.plus}`]: { transform: 'scale(0.4)', opacity: 0 },
      [`& .${ACCORDION_ICON.minus}`]: { transform: 'scale(1)', opacity: 1 },
    },
  };
}

const navigation: ComponentThemes = {
  MuiPaginationItem: {
    styleOverrides: {
      root: {
        [`&.${paginationItemClasses.selected}`]: { fontWeight: 600 },
        variants: paginationVariants,
      },
    },
  },
  MuiStepConnector: {
    styleOverrides: { line: ({ theme }) => ({ borderColor: theme.palette.divider }) },
  },
  MuiStepContent: {
    styleOverrides: { root: ({ theme }) => ({ borderColor: theme.palette.divider }) },
  },
  MuiAccordion: {
    defaultProps: { square: true },
    styleOverrides: {
      root: {
        backgroundColor: 'transparent',
        variants: [
          {
            props: is((props) => !props.disableGutters && !!props.expanded),
            style: ({ theme }) => ({
              boxShadow: shadowsOf(theme).z8,
              borderRadius: theme.shape.borderRadius,
              backgroundColor: theme.palette.background.paper,
            }),
          },
          {
            props: is((props) => !!props.disableGutters),
            style: ({ theme }) => ({
              borderBottom: `solid 1px ${theme.palette.divider}`,
              '&:last-of-type': { borderBottom: 'none' },
              '&::before': { display: 'none' },
              [`& .${accordionSummaryClasses.root}`]: { paddingLeft: 0, paddingRight: 0 },
              [`& .${accordionDetailsClasses.root}`]: { paddingLeft: 0, paddingRight: 0 },
            }),
          },
          {
            props: {},
            style: ({ theme }) => ({
              [`&.${accordionClasses.disabled}`]: {
                backgroundColor: 'transparent',
                [`& .${accordionDetailsClasses.root}`]: {
                  opacity: theme.palette.action.disabledOpacity,
                },
              },
            }),
          },
        ],
      },
    },
  },
  MuiAccordionSummary: {
    defaultProps: { expandIcon: ACCORDION_EXPAND_ICON },
    styleOverrides: {
      root: ({ theme }) => ({
        minHeight: 'auto',
        [`&.${accordionSummaryClasses.expanded}`]: { minHeight: 'inherit' },
        padding: theme.spacing(2, 1, 2, 2),
      }),
      content: {
        margin: 0,
        [`&.${accordionSummaryClasses.expanded}`]: { margin: 'inherit' },
      },
      expandIconWrapper: ({ theme }) => ({
        ...expandIconStyles(theme),
        color: 'inherit',
        alignSelf: 'flex-start',
        marginLeft: theme.spacing(2),
      }),
    },
  },
  MuiAccordionDetails: { styleOverrides: { root: { paddingTop: 0 } } },
  MuiLink: { defaultProps: { underline: 'hover' } },
  MuiBreadcrumbs: {
    styleOverrides: {
      ol: ({ theme }) => ({ rowGap: theme.spacing(0.5), columnGap: theme.spacing(2) }),
      li: ({ theme }) => ({ display: 'inline-flex', '& > *': { ...theme.typography.body2 } }),
      separator: { margin: 0 },
    },
  },
  MuiRating: {
    defaultProps: { icon: RATING_ICON, emptyIcon: RATING_ICON },
    styleOverrides: {
      icon: {
        variants: (
          [
            ['small', 20],
            ['medium', 24],
            ['large', 28],
          ] as const
        ).map(([size, fontSize]) => ({ props: { size }, style: { fontSize } })),
      },
      iconEmpty: ({ theme }) => ({
        color: fade(theme.palette.grey[500], theme.palette.action.disabledOpacity),
      }),
    },
  },
};

/** Korsi's surfaces and data display. */
export const surfaceComponents: ComponentThemes = {
  ...surfaces,
  ...tabs,
  ...display,
  ...data,
  ...navigation,
};
