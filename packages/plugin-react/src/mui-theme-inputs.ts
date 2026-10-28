/**
 * Korsi's look for MUI's form controls and buttons, ported from Korsi's theme
 * (`korsi-app/src/theme/core/components`): text fields in their three variants, labels and helper
 * text, selects, autocomplete, menus and popovers, checkbox, radio, switch, slider, and the buttons
 * (button, button group, toggle buttons, fab).
 */
import Fade from '@mui/material/Fade';
import { buttonClasses } from '@mui/material/Button';
import { buttonGroupClasses } from '@mui/material/ButtonGroup';
import { checkboxClasses } from '@mui/material/Checkbox';
import { fabClasses } from '@mui/material/Fab';
import { filledInputClasses } from '@mui/material/FilledInput';
import { formLabelClasses } from '@mui/material/FormLabel';
import { inputAdornmentClasses } from '@mui/material/InputAdornment';
import { inputBaseClasses } from '@mui/material/InputBase';
import { inputLabelClasses } from '@mui/material/InputLabel';
import { listClasses } from '@mui/material/List';
import { outlinedInputClasses } from '@mui/material/OutlinedInput';
import { radioClasses } from '@mui/material/Radio';
import { sliderClasses } from '@mui/material/Slider';
import { svgIconClasses } from '@mui/material/SvgIcon';
import { switchClasses } from '@mui/material/Switch';
import { toggleButtonClasses } from '@mui/material/ToggleButton';
import { autocompleteClasses } from '@mui/material/Autocomplete';
import { createElement } from 'react';
import type { Theme } from '@mui/material/styles';

import { ArrowDownIcon, CHECKBOX_ICONS, RADIO_ICONS } from './mui-theme-icons.js';
import {
  COLOR_KEYS,
  OPACITY,
  fade,
  filledStyles,
  isDark,
  menuItemStyles,
  paperStyles,
  shadowsOf,
  sharedOf,
  softStyles,
  type ColorKey,
  type ComponentThemes,
  type Css,
  type StyleArgs,
  type Variant,
} from './mui-theme-tokens.js';

const is =
  (match: (props: StyleArgs) => boolean) =>
  (props: StyleArgs): boolean =>
    match(props);

/** Whether a variant's props are for a small input (`size`, or an input slot's `inputSize`). */
const small = ({ size, ownerState }: StyleArgs) => (size || ownerState?.inputSize) === 'small';

/* -------------------------------------------------------------------------------------------- *
 * Text fields
 * -------------------------------------------------------------------------------------------- */

/** An input's text: 15 px on a 24 px line, 16 px on a phone (so iOS does not zoom into it). */
function inputType(theme: Theme, keys: ('fontSize' | 'height' | 'lineHeight')[]): Css {
  const at = (fontSize: number): Css => {
    const all: Css = {
      fontSize: theme.typography.pxToRem(fontSize),
      height: '24px',
      lineHeight: '24px',
    };
    return Object.fromEntries(keys.map((key) => [key, all[key]]));
  };
  return { ...at(15), [theme.breakpoints.down('sm')]: at(16) };
}

const PADDING = {
  base: { small: { paddingTop: 0, paddingBottom: 4 }, medium: { paddingTop: 4, paddingBottom: 4 } },
  outlined: {
    small: { paddingTop: 8, paddingBottom: 8 },
    medium: { paddingTop: 16, paddingBottom: 16 },
  },
  filled: {
    small: { paddingTop: 20 },
    medium: { paddingTop: 24 },
    smallHidden: { paddingTop: 8, paddingBottom: 8 },
    mediumHidden: { paddingTop: 16, paddingBottom: 16 },
  },
};

const multiline = is((props) => !!props.multiline);
const multilineInput: Variant[] = [{ props: multiline, style: { padding: 0 } }];

const textFields: ComponentThemes = {
  MuiInputBase: {
    styleOverrides: {
      root: ({ theme }) => ({
        '--disabled-color': theme.palette.action.disabled,
        ...inputType(theme, ['lineHeight']),
        [`&.${inputBaseClasses.disabled}`]: {
          [`& .${inputAdornmentClasses.root} *`]: { color: 'var(--disabled-color)' },
          [`& .${inputBaseClasses.input}`]: { WebkitTextFillColor: 'var(--disabled-color)' },
        },
        variants: [
          { props: multiline, style: PADDING.base.medium },
          { props: is((props) => !!props.multiline && small(props)), style: PADDING.base.small },
        ],
      }),
      input: ({ theme }) => ({
        ...inputType(theme, ['fontSize', 'height', 'lineHeight']),
        '&:focus': { borderRadius: 'inherit' },
        // One rule per pseudo-element: a selector list is dropped whole by a browser that does not
        // know one of its members.
        '&::placeholder': { color: theme.palette.text.disabled, opacity: 1 },
        '&::-webkit-input-placeholder': { color: theme.palette.text.disabled, opacity: 1 },
        variants: [
          { props: {}, style: PADDING.base.medium },
          { props: is(small), style: PADDING.base.small },
          ...multilineInput,
        ],
      }),
    },
  },
  MuiInput: {
    styleOverrides: {
      root: ({ theme }) => ({
        '&::before': { borderBottomColor: sharedOf(theme).inputUnderline },
        '&::after': { borderBottomColor: theme.palette.text.primary },
      }),
    },
  },
  MuiOutlinedInput: {
    styleOverrides: {
      root: ({ theme }) => ({
        [`&.${outlinedInputClasses.focused}:not(.${outlinedInputClasses.error})`]: {
          [`& .${outlinedInputClasses.notchedOutline}`]: {
            borderColor: theme.palette.text.primary,
          },
        },
        [`&.${outlinedInputClasses.disabled}`]: {
          [`& .${outlinedInputClasses.notchedOutline}`]: {
            borderColor: theme.palette.action.disabledBackground,
          },
        },
        variants: [
          { props: multiline, style: PADDING.outlined.medium },
          {
            props: is((props) => !!props.multiline && small(props)),
            style: PADDING.outlined.small,
          },
        ],
      }),
      input: {
        variants: [
          { props: {}, style: PADDING.outlined.medium },
          { props: is(small), style: PADDING.outlined.small },
          ...multilineInput,
        ],
      },
      notchedOutline: ({ theme }) => ({
        borderColor: sharedOf(theme).inputOutlined,
        transition: theme.transitions.create(['border-color'], {
          duration: theme.transitions.duration.shortest,
        }),
      }),
    },
  },
  MuiFilledInput: {
    defaultProps: { disableUnderline: true },
    styleOverrides: {
      root: ({ theme }) => {
        const grey = theme.palette.grey[500];
        const error = theme.palette.error.main;
        return {
          backgroundColor: fade(grey, 0.08),
          borderRadius: theme.shape.borderRadius,
          [`&:hover, &.${filledInputClasses.focused}`]: { backgroundColor: fade(grey, 0.16) },
          [`&.${filledInputClasses.error}`]: {
            backgroundColor: fade(error, 0.08),
            [`&:hover, &.${filledInputClasses.focused}`]: { backgroundColor: fade(error, 0.16) },
          },
          [`&.${filledInputClasses.disabled}`]: {
            backgroundColor: theme.palette.action.disabledBackground,
          },
          variants: [
            { props: multiline, style: PADDING.filled.medium },
            {
              props: is((props) => !!props.multiline && small(props)),
              style: PADDING.filled.small,
            },
            {
              props: is((props) => !!props.multiline && !!props.hiddenLabel),
              style: PADDING.filled.mediumHidden,
            },
            {
              props: is((props) => !!props.multiline && !!props.hiddenLabel && small(props)),
              style: PADDING.filled.smallHidden,
            },
          ],
        };
      },
      input: {
        variants: [
          { props: {}, style: PADDING.filled.medium },
          { props: is(small), style: PADDING.filled.small },
          { props: is((props) => !!props.hiddenLabel), style: PADDING.filled.mediumHidden },
          {
            props: is((props) => !!props.hiddenLabel && small(props)),
            style: PADDING.filled.smallHidden,
          },
          ...multilineInput,
        ],
      },
    },
  },
  MuiTextField: { defaultProps: { variant: 'outlined' } },
  MuiFormControl: { defaultProps: { variant: 'outlined' } },
  MuiInputLabel: {
    styleOverrides: {
      root: ({ theme }) => ({
        variants: [
          {
            props: is((props) => !props.shrink),
            style: {
              ...inputType(theme, ['fontSize', 'lineHeight']),
              color: theme.palette.text.disabled,
            },
          },
          {
            props: is((props) => !!props.shrink),
            style: {
              fontWeight: 600,
              [`&.${inputLabelClasses.focused}:not(.${inputLabelClasses.error})`]: {
                color: 'inherit',
              },
            },
          },
          {
            props: is(
              (props) => !!props.shrink && props.variant === 'filled' && props.size === 'medium'
            ),
            style: { transform: 'translate(12px, 6px) scale(0.75)' },
          },
        ],
      }),
    },
  },
  MuiFormLabel: {
    styleOverrides: {
      root: ({ theme }) => ({
        [`&.${formLabelClasses.disabled}`]: { color: theme.palette.action.disabled },
        variants: [
          {
            props: is((props) => !props.error),
            style: { [`&.${formLabelClasses.focused}`]: { color: theme.palette.text.secondary } },
          },
        ],
      }),
    },
  },
  MuiFormControlLabel: {
    styleOverrides: { label: ({ theme }) => ({ ...theme.typography.body2 }) },
  },
  MuiFormHelperText: {
    defaultProps: { component: 'div' },
    styleOverrides: {
      root: ({ theme }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing(0.5),
        margin: theme.spacing(0.75, 1.5, 0, 1.5),
        '& > svg': { width: 16, height: 16 },
      }),
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Selects, autocomplete, menus, popovers
 * -------------------------------------------------------------------------------------------- */

const SELECT_ICON: Css = { right: 10, width: 18, height: 18, top: 'calc(50% - 9px)' };

const pickers: ComponentThemes = {
  MuiSelect: {
    defaultProps: { IconComponent: ArrowDownIcon },
    styleOverrides: { icon: SELECT_ICON },
  },
  MuiNativeSelect: {
    defaultProps: { IconComponent: ArrowDownIcon },
    styleOverrides: { icon: SELECT_ICON },
  },
  MuiAutocomplete: {
    defaultProps: { popupIcon: createElement(ArrowDownIcon) },
    styleOverrides: {
      root: ({ theme }) => ({
        [`& span.${autocompleteClasses.tag}`]: {
          ...theme.typography.subtitle2,
          height: 24,
          minWidth: 24,
          lineHeight: '24px',
          textAlign: 'center',
          padding: theme.spacing(0, 0.75),
          color: theme.palette.text.secondary,
          borderRadius: theme.shape.borderRadius,
          backgroundColor: fade(theme.palette.grey[500], 0.16),
        },
      }),
      paper: ({ theme }) => paperStyles(theme, { dropdown: true }),
      listbox: ({ theme }) => ({
        padding: 0,
        [`& .${autocompleteClasses.option}`]: menuItemStyles(theme),
      }),
      endAdornment: { [`& .${svgIconClasses.root}`]: { fontSize: 18 } },
    },
  },
  // A menu opens solid and without a zoom: over a form the blur does not always take, and a
  // menu scaling up from 75% puts the item passing under the pointer where the click lands.
  MuiMenu: {
    defaultProps: { slots: { transition: Fade } },
    styleOverrides: {
      paper: ({ theme }) => ({ backgroundColor: theme.palette.background.paper }),
    },
  },
  MuiMenuItem: { styleOverrides: { root: ({ theme }) => menuItemStyles(theme) } },
  MuiPopover: {
    styleOverrides: {
      paper: ({ theme }) => ({
        ...paperStyles(theme, { dropdown: true }),
        [`& .${listClasses.root}`]: { paddingTop: 0, paddingBottom: 0 },
      }),
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Checkbox, radio, switch, slider
 * -------------------------------------------------------------------------------------------- */

const SWITCH = {
  small: { thumb: 10, track: 16, trackRadius: 8, translateX: '10px' },
  medium: { thumb: 14, track: 20, trackRadius: 10, translateX: '14px' },
};

const SLIDER = {
  small: { rail: 6, thumb: 16, mark: 4 },
  medium: { rail: 10, thumb: 20, mark: 6 },
} as const;
const SLIDER_SIZES = ['small', 'medium'] as const;
const ORIENTATIONS = ['horizontal', 'vertical'] as const;

const sliderBars: Variant[] = ORIENTATIONS.flatMap((orientation) =>
  SLIDER_SIZES.map((size) => ({
    props: is((props) => props.orientation === orientation && props.size === size),
    style:
      orientation === 'horizontal' ? { height: SLIDER[size].rail } : { width: SLIDER[size].rail },
  }))
);

const controls: ComponentThemes = {
  MuiCheckbox: {
    defaultProps: { size: 'small', ...CHECKBOX_ICONS },
    styleOverrides: {
      root: ({ theme }) => ({
        padding: theme.spacing(1),
        variants: [
          {
            props: { color: 'default' },
            style: { [`&.${checkboxClasses.checked}`]: { color: theme.palette.text.primary } },
          },
        ],
      }),
    },
  },
  MuiRadio: {
    defaultProps: { size: 'small', ...RADIO_ICONS },
    styleOverrides: {
      root: ({ theme }) => ({
        padding: theme.spacing(1),
        variants: [
          {
            props: { color: 'default' },
            style: { [`&.${radioClasses.checked}`]: { color: theme.palette.text.primary } },
          },
        ],
      }),
    },
  },
  MuiSwitch: {
    styleOverrides: {
      root: {
        alignItems: 'center',
        variants: [
          {
            props: { size: 'small' },
            style: {
              [`& .${switchClasses.switchBase}`]: {
                [`&.${switchClasses.checked}`]: {
                  transform: `translateX(${SWITCH.small.translateX})`,
                },
              },
              [`& .${switchClasses.thumb}`]: {
                width: SWITCH.small.thumb,
                height: SWITCH.small.thumb,
              },
              [`& .${switchClasses.track}`]: {
                height: SWITCH.small.track,
                borderRadius: SWITCH.small.trackRadius,
              },
            },
          },
        ],
      },
      switchBase: ({ theme }) => ({
        top: 'auto',
        left: '6px',
        variants: [
          {
            props: { color: 'default' },
            style: {
              [`&.${switchClasses.checked}`]: {
                [`& + .${switchClasses.track}`]: { backgroundColor: theme.palette.text.primary },
                ...(isDark(theme) && {
                  [`& .${switchClasses.thumb}`]: { color: theme.palette.grey[800] },
                }),
              },
            },
          },
          {
            props: {},
            style: {
              [`&.${switchClasses.disabled}`]: {
                [`& + .${switchClasses.track}`]: { opacity: OPACITY.switchTrackDisabled },
                ...(isDark(theme) && {
                  [`& .${switchClasses.thumb}`]: { opacity: OPACITY.switchTrackDisabled },
                }),
              },
            },
          },
          {
            props: {},
            style: {
              [`&.${switchClasses.checked}`]: {
                transform: `translateX(${SWITCH.medium.translateX})`,
                [`& + .${switchClasses.track}`]: { opacity: OPACITY.switchTrack },
              },
            },
          },
        ],
      }),
      thumb: ({ theme }) => ({
        width: SWITCH.medium.thumb,
        height: SWITCH.medium.thumb,
        color: theme.palette.common.white,
      }),
      track: ({ theme }) => ({
        height: SWITCH.medium.track,
        borderRadius: SWITCH.medium.trackRadius,
        backgroundColor: fade(theme.palette.grey[500], 0.48),
      }),
    },
  },
  MuiSlider: {
    defaultProps: { size: 'small' },
    styleOverrides: {
      root: ({ theme }) => ({
        [`&.${sliderClasses.disabled}`]: { color: theme.palette.action.disabled },
      }),
      thumb: ({ theme }) => ({
        boxShadow: shadowsOf(theme).z1,
        color: theme.palette.common.white,
        border: `solid 1px ${fade(theme.palette.grey[500], 0.08)}`,
        '&::before': {
          opacity: isDark(theme) ? 0.8 : 0.4,
          boxShadow: 'none',
          width: 'calc(100% - 4px)',
          height: 'calc(100% - 4px)',
          backgroundImage: `linear-gradient(180deg, ${theme.palette.grey[500]}, transparent)`,
        },
        variants: SLIDER_SIZES.map((size) => ({
          props: { size },
          style: { width: SLIDER[size].thumb, height: SLIDER[size].thumb },
        })),
      }),
      rail: ({ theme }) => ({
        opacity: 0.12,
        backgroundColor: theme.palette.grey[500],
        variants: sliderBars,
      }),
      track: { variants: sliderBars },
      mark: ({ theme, style }) => {
        const at = style as { left?: string; bottom?: string } | undefined;
        return {
          backgroundColor: fade(theme.palette.grey[500], 0.48),
          '&[data-index="0"]': { display: 'none' },
          ...((at?.left ?? at?.bottom) === '100%' && { display: 'none' }),
          variants: ORIENTATIONS.flatMap((orientation) =>
            SLIDER_SIZES.map((size) => ({
              props: is((props) => props.orientation === orientation && props.size === size),
              style:
                orientation === 'horizontal'
                  ? { width: 1, height: SLIDER[size].mark }
                  : { height: 1, width: SLIDER[size].mark },
            }))
          ),
        };
      },
      markActive: ({ theme }) => ({
        backgroundColor: fade(theme.palette.common.white, 0.64),
        variants: [
          {
            props: { color: 'inherit' },
            style: isDark(theme) ? { backgroundColor: fade(theme.palette.grey[800], 0.48) } : {},
          },
        ],
      }),
      markLabel: ({ theme }) => ({
        fontSize: theme.typography.pxToRem(13),
        color: theme.palette.text.disabled,
      }),
      valueLabel: ({ theme }) => ({
        borderRadius: 8,
        backgroundColor: isDark(theme) ? theme.palette.grey[700] : theme.palette.grey[800],
      }),
    },
  },
};

/* -------------------------------------------------------------------------------------------- *
 * Buttons
 * -------------------------------------------------------------------------------------------- */

const BUTTON_SIZES = {
  small: { '--padding-y': '4px', '--padding-x': '8px', minHeight: 30, lineHeight: 22 / 13 },
  medium: { '--padding-y': '6px', '--padding-x': '12px', minHeight: 36, lineHeight: 24 / 14 },
  large: { '--padding-y': '8px', '--padding-x': '16px', minHeight: 48, lineHeight: 26 / 15 },
};

const softKeys = ['inherit', ...COLOR_KEYS] as const;

const buttonVariants: Variant[] = [
  // Contained: `inherit` is ink; a palette colour casts its own shadow on hover.
  {
    props: { variant: 'contained', color: 'inherit' },
    style: ({ theme }) => filledStyles(theme, 'inherit', { boxShadow: shadowsOf(theme).z8 }),
  },
  ...COLOR_KEYS.map((key): Variant => ({
    props: { variant: 'contained', color: key },
    style: ({ theme }) => ({ '&:hover': { boxShadow: shadowsOf(theme).color(key) } }),
  })),
  // Outlined: a faint line in the text's colour, drawn fully on hover.
  {
    props: { variant: 'outlined' },
    style: ({ theme }) => ({
      borderColor: fade('currentColor', OPACITY.outlinedBorder),
      '&:hover': {
        borderColor: 'currentColor',
        boxShadow: '0 0 0 0.75px currentColor',
        backgroundColor: fade('currentColor', theme.palette.action.hoverOpacity),
      },
    }),
  },
  {
    props: { variant: 'outlined', color: 'inherit' },
    style: ({ theme }) => ({
      borderColor: sharedOf(theme).buttonOutlined,
      '&:hover': { backgroundColor: theme.palette.action.hover },
    }),
  },
  {
    props: { variant: 'text' },
    style: ({ theme }) => ({
      '&:hover': { backgroundColor: fade('currentColor', theme.palette.action.hoverOpacity) },
    }),
  },
  {
    props: { variant: 'text', color: 'inherit' },
    style: ({ theme }) => ({ '&:hover': { backgroundColor: theme.palette.action.hover } }),
  },
  // Soft: the colour's tint behind its darker shade.
  ...softKeys.map((key): Variant => ({
    props: { variant: 'soft', color: key },
    style: ({ theme }) => softStyles(theme, key, true),
  })),
  // Sizes: every variant pads from the same two numbers.
  { props: {}, style: { padding: 'var(--padding-y) var(--padding-x)' } },
  { props: { size: 'small' }, style: BUTTON_SIZES.small },
  { props: { size: 'medium' }, style: BUTTON_SIZES.medium },
  { props: { size: 'large' }, style: BUTTON_SIZES.large },
  {
    props: { variant: 'outlined' },
    style: {
      paddingTop: 'calc(var(--padding-y) - 4px)',
      paddingBottom: 'calc(var(--padding-y) - 4px)',
    },
  },
  {
    props: { variant: 'text' },
    style: {
      paddingLeft: 'calc(var(--padding-x) - 4px)',
      paddingRight: 'calc(var(--padding-x) - 4px)',
    },
  },
  {
    props: { variant: 'soft' },
    style: ({ theme }) => ({
      [`&.${buttonClasses.disabled}`]: {
        backgroundColor: theme.palette.action.disabledBackground,
      },
    }),
  },
];

const buttonGroupVariants: Variant[] = [
  {
    props: { variant: 'contained' },
    style: ({ theme }) => ({ borderColor: sharedOf(theme).buttonOutlined }),
  },
  ...COLOR_KEYS.map((key): Variant => ({
    props: { variant: 'contained', color: key },
    style: ({ theme }) => ({
      borderColor: fade(theme.palette[key].dark, OPACITY.outlinedBorder),
    }),
  })),
  {
    props: { variant: 'text' },
    style: { borderColor: fade('currentColor', OPACITY.outlinedBorder) },
  },
  {
    props: { variant: 'text', color: 'inherit' },
    style: ({ theme }) => ({ borderColor: sharedOf(theme).buttonOutlined }),
  },
  {
    props: { variant: 'soft' },
    style: { borderStyle: 'solid', borderColor: fade('currentColor', OPACITY.softBorder) },
  },
  {
    props: { variant: 'soft', color: 'inherit' },
    style: ({ theme }) => ({ borderColor: sharedOf(theme).buttonOutlined }),
  },
  {
    props: {},
    style: ({ theme }) => ({
      [`&.${buttonGroupClasses.disabled}`]: {
        borderColor: theme.palette.action.disabledBackground,
      },
    }),
  },
];

const softGroupEdge: Variant[] = [
  { props: { variant: 'soft', orientation: 'horizontal' }, style: { borderRightWidth: 1 } },
  { props: { variant: 'soft', orientation: 'vertical' }, style: { borderBottomWidth: 1 } },
];

const TOGGLE_SIZES = {
  small: { '--size': '40px', '--padding': '7px' },
  medium: { '--size': '48px', '--padding': '11px' },
  large: { '--size': '56px', '--padding': '15px' },
};

const FAB_EXTENDED = {
  small: { '--size': '36px', padding: '4px 8px', fontSize: '0.8125rem', lineHeight: 22 / 13 },
  medium: { '--size': '40px', padding: '6px 12px', fontSize: '0.875rem', lineHeight: 24 / 14 },
  large: { '--size': '48px', padding: '8px 16px', fontSize: '0.9375rem', lineHeight: 26 / 15 },
};

const fabIs = (variants: string[], color?: string) =>
  is(
    (props) =>
      typeof props.variant === 'string' &&
      variants.includes(props.variant) &&
      (color === undefined || props.color === color)
  );
const FAB_FILLED = ['circular', 'extended'];
const FAB_OUTLINED = ['outlined', 'outlinedExtended'];
const FAB_SOFT = ['soft', 'softExtended'];
const FAB_EXTENDED_VARIANTS = ['extended', 'outlinedExtended', 'softExtended'];

const fabVariants: Variant[] = [
  ...(['default', 'inherit'] as const).map((key): Variant => ({
    props: fabIs(FAB_FILLED, key),
    style: ({ theme }) => ({
      ...filledStyles(theme, key, true),
      boxShadow: shadowsOf(theme).z8,
    }),
  })),
  ...COLOR_KEYS.map((key): Variant => ({
    props: fabIs(FAB_FILLED, key),
    style: ({ theme }) => ({ boxShadow: shadowsOf(theme).color(key) }),
  })),
  {
    props: fabIs(FAB_OUTLINED),
    style: ({ theme }) => ({
      borderWidth: 1,
      boxShadow: 'none',
      borderStyle: 'solid',
      backgroundColor: 'transparent',
      borderColor: fade('currentColor', OPACITY.outlinedBorder),
      '&:hover': {
        borderColor: 'currentColor',
        boxShadow: '0 0 0 0.75px currentColor',
        backgroundColor: fade('currentColor', theme.palette.action.hoverOpacity),
      },
    }),
  },
  {
    props: is(
      (props) =>
        FAB_OUTLINED.includes(String(props.variant)) &&
        (props.color === 'default' || props.color === 'inherit')
    ),
    style: ({ theme }) => ({
      borderColor: sharedOf(theme).buttonOutlined,
      '&:hover': { backgroundColor: theme.palette.action.hover },
    }),
  },
  {
    props: fabIs(FAB_OUTLINED, 'default'),
    style: ({ theme }) => ({ color: theme.palette.action.active }),
  },
  ...COLOR_KEYS.map((key): Variant => ({
    props: fabIs(FAB_OUTLINED, key),
    style: ({ theme }) => ({ color: theme.palette[key].main }),
  })),
  ...(['default', 'inherit', ...COLOR_KEYS] as const).map((key): Variant => ({
    props: fabIs(FAB_SOFT, key),
    style: ({ theme }) => softStyles(theme, key, true),
  })),
  {
    props: fabIs(FAB_EXTENDED_VARIANTS),
    style: ({ theme }) => ({
      width: 'auto',
      height: 'auto',
      gap: theme.spacing(1),
      minWidth: 'var(--size)',
      minHeight: 'var(--size)',
      borderRadius: 'calc(var(--size) / 2)',
    }),
  },
  ...(['small', 'medium', 'large'] as const).map((size): Variant => ({
    props: is(
      (props) => FAB_EXTENDED_VARIANTS.includes(String(props.variant)) && props.size === size
    ),
    style: FAB_EXTENDED[size],
  })),
  {
    props: fabIs(FAB_OUTLINED),
    style: ({ theme }) => ({
      [`&.${fabClasses.disabled}`]: {
        backgroundColor: 'transparent',
        borderColor: theme.palette.action.disabledBackground,
      },
    }),
  },
];

const buttons: ComponentThemes = {
  MuiButtonBase: {
    styleOverrides: { root: ({ theme }) => ({ fontFamily: theme.typography.fontFamily }) },
  },
  MuiButton: {
    // `primary`: a contained button that names no colour is the screen's one action, not a
    // neutral slab. A deliberately neutral button says `color="inherit"`.
    defaultProps: { color: 'primary', disableElevation: true },
    styleOverrides: { root: { variants: buttonVariants } },
  },
  MuiButtonGroup: {
    defaultProps: { color: 'inherit', disableElevation: true },
    styleOverrides: {
      grouped: { variants: buttonGroupVariants },
      firstButton: { variants: softGroupEdge },
      middleButton: { variants: softGroupEdge },
    },
  },
  MuiToggleButton: {
    styleOverrides: {
      root: ({ theme }) => ({
        gap: 8,
        minWidth: 'var(--size)',
        minHeight: 'var(--size)',
        padding: 'var(--padding)',
        fontWeight: 600,
        variants: [
          ...COLOR_KEYS.map((key: ColorKey): Variant => ({
            props: { color: key },
            style: {
              '&:hover': {
                borderColor: fade(theme.palette[key].main, OPACITY.outlinedBorder),
                backgroundColor: fade(theme.palette[key].main, theme.palette.action.hoverOpacity),
              },
            },
          })),
          ...(['small', 'medium', 'large'] as const).map((size): Variant => ({
            props: { size },
            style: TOGGLE_SIZES[size],
          })),
          {
            props: {},
            style: {
              [`&.${toggleButtonClasses.selected}`]: {
                borderColor: 'currentColor',
                boxShadow: '0 0 0 0.75px currentColor',
              },
              [`&.${toggleButtonClasses.disabled}`]: {
                boxShadow: 'none',
                color: theme.palette.action.disabled,
                borderColor: theme.palette.action.disabledBackground,
                [`&.${toggleButtonClasses.selected}`]: {
                  backgroundColor: theme.palette.action.disabledBackground,
                },
              },
            },
          },
        ],
      }),
    },
  },
  MuiToggleButtonGroup: {
    styleOverrides: {
      root: ({ theme }) => ({
        '--group-gap': '4px',
        gap: 'var(--group-gap)',
        padding: 'var(--group-gap)',
        border: `1px solid ${sharedOf(theme).paperOutlined}`,
      }),
      grouped: {
        border: 'none',
        borderRadius: 'inherit',
        padding: 'calc(var(--padding) - var(--group-gap))',
        minWidth: 'calc(var(--size) - (var(--group-gap) * 2 + 2px))',
        minHeight: 'calc(var(--size) - (var(--group-gap) * 2 + 2px))',
        variants: [
          {
            props: {},
            style: {
              [`&.${toggleButtonClasses.selected}`]: { boxShadow: 'none' },
              [`&.${toggleButtonClasses.disabled}`]: { border: 'none' },
            },
          },
        ],
      },
    },
  },
  MuiFab: {
    defaultProps: { color: 'primary', size: 'medium' },
    styleOverrides: { root: { '&:hover': { boxShadow: 'none' }, variants: fabVariants } },
  },
};

/** Korsi's form controls and buttons. */
export const inputComponents: ComponentThemes = {
  ...textFields,
  ...pickers,
  ...controls,
  ...buttons,
};
