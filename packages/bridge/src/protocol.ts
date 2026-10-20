/**
 * The Bridge's protocol, `korsi-bridge/1`, as types: what Korsi tells a plugin's page, and what the
 * page may ask.
 *
 * The runtime that speaks it is not in this package. Korsi serves it (`<korsi>/sdk/korsi-bridge.js`)
 * and the page imports it from the Korsi that frames it, so a page always speaks the protocol of the
 * Korsi it is in, whatever version of this package it was built with. These types describe that
 * file; a test in this repository holds them to it.
 */

/** The envelope's version. A plugin built for another one is ignored rather than misread. */
export const PROTOCOL = 'korsi-bridge/1';

/** Every message type, both ways. */
export const MESSAGES = Object.freeze({
  ready: 'korsi:ready',
  init: 'korsi:init',
  reply: 'korsi:reply',
  handleRenew: 'korsi:handle.renew',
  navigate: 'korsi:navigate',
  resize: 'korsi:resize',
  toast: 'korsi:toast',
  confirm: 'korsi:confirm',
  pickPerson: 'korsi:pick.person',
  pickCase: 'korsi:pick.case',
  askKorsyar: 'korsi:ask.korsyar',
} as const);

export type MessageName = keyof typeof MESSAGES;
export type MessageType = (typeof MESSAGES)[MessageName];

/** Codes a refused request is rejected with (`error.code`). Stable: branch on them. */
export type BridgeErrorCode =
  | 'invalid_payload'
  | 'unknown_type'
  /** Another question to the person is already open. */
  | 'busy'
  | 'failed'
  | 'timeout';

/** Korsi's colours, resolved for the current mode. Any may be missing; keep a fallback. */
export interface KorsiPalette {
  primary?: string;
  on_primary?: string;
  secondary?: string;
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
  background?: string;
  paper?: string;
  text?: string;
  text_secondary?: string;
  divider?: string;
}

export interface KorsiTheme {
  mode: 'light' | 'dark';
  /**
   * Korsi's whole font stack, the organization's digits included (`"Korsi Latin Digits", YekanBakh,
   * ...`). The faces in it are Korsi's: load them with `@korsi/plugin-ui`'s `loadKorsiFonts`.
   */
  font_family?: string;
  palette: KorsiPalette;
}

/** A person's authority sealed to this installation, for at most fifteen minutes. Never keep it. */
export interface KorsiHandle {
  token: string;
  expires_at: string;
}

/** The record a panel is drawn beside; `desk` for the person's own desk. */
export interface KorsiRecordContext {
  kind: 'case' | 'meeting' | 'document' | 'desk' | (string & {});
  id: string | null;
  title: string | null;
}

/** `korsi:init`: who, where and how. Sent after `korsi:ready`, and again whenever any of it changes. */
export interface KorsiContext {
  /** The person's language: `fa`, `en`, `ar`. */
  locale: string;
  dir: 'rtl' | 'ltr';
  theme: KorsiTheme;
  /** The organization's calendar. */
  calendar_system: 'jalali' | 'gregorian';
  /** The organization's digits. */
  numerals: 'persian' | 'latin';
  /** The person's time zone (IANA), when Korsi knows it. */
  timezone: string | null;
  user: { id: string; name: string | null } | null;
  organization: { slug: string; name: string } | null;
  installation_id: string;
  plugin_id: string;
  /** The plugin's own path Korsi's address shows, under its entry. */
  path: string;
  /** The record in context, for a panel; absent for the app. */
  context?: KorsiRecordContext | null;
  handle: KorsiHandle | null;
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ConfirmQuestion {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
}

export interface PickedPerson {
  user_id: string;
  name: string;
}

export interface PickedCase {
  case_id: string;
  title: string;
}

export interface ConnectOptions {
  /** The Korsi origins this page trusts. Pass them in production. */
  allowedOrigins?: string[];
  /** How long to wait for `korsi:init`, in milliseconds. */
  timeout?: number;
}

/** The runtime module Korsi serves at `/sdk/korsi-bridge.js`. */
export interface KorsiBridge {
  readonly MESSAGES: Readonly<Record<MessageName, string>>;
  /** Absent from runtimes older than this package; the loader then assumes `korsi-bridge/1`. */
  readonly PROTOCOL?: string;
  /** Start talking to Korsi. Resolves with the first `korsi:init`'s context. */
  connect(options?: ConnectOptions): Promise<KorsiContext>;
  /** Called with every context Korsi sends -- the first and each change. Returns an unsubscribe. */
  onInit(listener: (context: KorsiContext) => void): () => unknown;
  /** Called when Korsi's address moves under the page (back button, a tab). */
  onNavigate(listener: (path: string) => void): () => unknown;
  /** The context Korsi last sent, or null before `korsi:init`. */
  getContext(): KorsiContext | null;
  /** A live handle's token, renewed before it runs out. Send it to your server; never keep it. */
  getHandle(): Promise<string>;
  /** Tell Korsi the page moved, so its address follows. */
  navigate(path: string, options?: { replace?: boolean }): void;
  /** Tell Korsi the page's height; with none, keep telling it until the returned function runs. */
  resize(height?: number): () => void;
  /** A short notice in Korsi's own toast, under the plugin's name. */
  toast(message: string, kind?: ToastKind): void;
  /** Ask the person in Korsi's own dialog. True when they confirm. */
  confirm(question: ConfirmQuestion): Promise<boolean>;
  /** The person picks a colleague in Korsi's picker, or null. */
  pickPerson(options?: { title?: string }): Promise<PickedPerson | null>;
  /** The person picks a case they can see, or null. */
  pickCase(options?: { title?: string }): Promise<PickedCase | null>;
  /** Offer a question to Korsyar; sent only when the person presses send. True once sent. */
  askKorsyar(prompt: string): Promise<boolean>;
}

/** The runtime's functions, for checking a loaded module is the Bridge. */
export const BRIDGE_FUNCTIONS = Object.freeze([
  'connect',
  'onInit',
  'onNavigate',
  'getContext',
  'getHandle',
  'navigate',
  'resize',
  'toast',
  'confirm',
  'pickPerson',
  'pickCase',
  'askKorsyar',
] as const satisfies ReadonlyArray<keyof KorsiBridge>);
