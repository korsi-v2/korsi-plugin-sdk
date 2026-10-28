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
  openProposal: 'korsi:open.proposal',
  pickFile: 'korsi:pick.file',
  show: 'korsi:show',
  openApp: 'korsi:open.app',
  meetingLive: 'korsi:meeting.live',
  credentialRenew: 'korsi:credential.renew',
  title: 'korsi:title',
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

/**
 * How tightly the person has Korsi drawn, from Korsi's display settings, resolved to the numbers
 * Korsi draws its own page with -- so a page that uses them sits flush with the Korsi around it.
 */
export interface KorsiDisplay {
  /** The person's density: `compact` (Korsi's default) or `comfortable`. */
  density: 'compact' | 'comfortable';
  /** The unit every padding and gap multiplies, in px: 6 compact, 8 comfortable. */
  spacing: number;
  /** The corner radius, in px: 6 compact, 8 comfortable. */
  radius: number;
  /**
   * The root font size, in px: the size the person chose (16 unless they changed it) scaled by the
   * density (15/16 compact). Every rem in Korsi's type scale is a multiple of it. Absent when Korsi
   * leaves the root to the browser.
   */
  font_size?: number;
  /**
   * The person's contrast. `high` lays a light page on a grey ground (already in
   * `palette.background`) and gives cards Korsi's lighter `z1` shadow.
   */
  contrast: 'default' | 'high';
}

export interface KorsiTheme {
  mode: 'light' | 'dark';
  /**
   * Korsi's whole font stack, the organization's digits included (`"Korsi Latin Digits", YekanBakh,
   * ...`). The faces in it are Korsi's: load them with `@korsi/plugin-ui`'s `loadKorsiFonts`.
   */
  font_family?: string;
  palette: KorsiPalette;
  /**
   * The person's density, root font size and contrast. Sent again, like the rest of the theme,
   * when they change it. Absent from a Korsi older than this package: draw at MUI's own scale
   * (8px spacing and corners, 16px root) there.
   */
  display?: KorsiDisplay;
}

/** A person's authority sealed to this installation, for at most fifteen minutes. Never keep it. */
export interface KorsiHandle {
  token: string;
  expires_at: string;
}

/**
 * Where in Korsi's own pages a plugin's panel is shown (the manifest's `ui.panels[].point`): beside
 * a record, on the person's desk, or in the live room's side column for a meeting the installation
 * hosts (ADR-0083).
 */
export type ExtensionPoint = 'record.panel' | 'desk.widget' | 'meeting.live.panel';

/**
 * The record a panel is drawn beside; `desk` for the person's own desk. A `meeting.live.panel`
 * frame is drawn beside its meeting (`{ kind: 'meeting', id }`).
 */
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

/** How a proposal the page opened for the person ended: `applied`, `rejected` or `failed`. */
export interface DecidedProposal {
  status: 'applied' | 'rejected' | 'failed' | 'expired' | 'superseded' | 'pending';
  /** The work saving it created, for an applied `action.create`. */
  action_id: string | null;
  /**
   * The case saving it made (`case.create`) or moved (`case.stage.move`). Absent from a Korsi
   * older than plugin API 1.2.
   */
  case_id?: string | null;
  /** The decision saving it recorded, for a `decision.candidate`. Absent before plugin API 1.2. */
  decision_id?: string | null;
  /** Why applying it failed. */
  error_code: string | null;
}

/** What the person may pick in Korsi's file picker (`pickFile`). */
export interface PickFileOptions {
  /** Several files at once. */
  multiple?: boolean;
  /** Media types or extensions the picker offers (`application/pdf`, `.docx`, `image/*`). */
  accept?: string[];
}

/**
 * A file the person picked for this installation. Korsi has handed it to the installation before
 * answering, so the plugin's server reads it -- `GET /plugin/v1/files/{file_id}`, `/content`,
 * `/text` -- as the person, or later as itself.
 */
export interface PickedFile {
  file_id: string;
  name: string;
  /** In bytes, when Korsi knows. */
  size: number | null;
  /** What Korsi read the file as, when it knows: for showing, never for trusting. */
  media_type: string | null;
}

/** One of Korsi's own pages a plugin may send the person to (`showInKorsi`). */
export interface KorsiPageRef {
  kind: 'meeting' | 'case' | 'decision' | 'action';
  id: string;
}

/**
 * One stretch of speech heard in the live room: a preview, not the record. `speaker` is a
 * member's name, or the name the room gave a voice; `speaker_key` stays the same for one voice, so
 * a line said before the voice was named can take the name it is given later.
 */
export interface LiveSegment {
  id: string;
  speaker: string;
  speaker_key: string;
  speaker_user_id: string | null;
  text: string;
  at: string;
}

/**
 * `korsi:meeting.live`: the live room's state, pushed to a `meeting.live.panel` frame of the
 * installation that hosts the meeting -- on every new batch of lines and on every change of state.
 * The first push after the panel loads carries everything said so far; later ones only new or
 * changed lines -- merge them by `id`, a line sent again with other words replacing the earlier
 * one. A page that reloads inside its frame is sent everything again. `covered_through` is the
 * live transcript's cursor (`GET /plugin/v1/meetings/{id}/live/transcript?since=`).
 */
export interface MeetingLive {
  meeting_id: string;
  state: 'waiting' | 'live' | 'ended';
  elapsed_seconds: number;
  covered_through: string | null;
  segments: LiveSegment[];
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
  /**
   * Tell Korsi the page moved, so its address follows. Korsi records the move in its history, so
   * the back button returns to the screen before it (and arrives as `onNavigate`); `replace` moves
   * the address without a history entry (a redirect, a corrected path). `back` is a move back to
   * the screen before -- a form or dialog closed by its own button: Korsi steps its history back
   * when the entry before is `path`, so the closed screen is ahead (forward reopens it) rather than
   * left as a second copy of the same address that the next back press would stay on; otherwise it
   * replaces. Nothing comes back for a step Korsi took (no `onNavigate`: the page is already
   * there). Pass it with `replace` (`{ replace: true, back: true }`, as `@korsi/plugin-react`'s
   * `useKorsiNavigation` does), so a Korsi older than `back` replaces. Move with your own router;
   * never change the frame's own address.
   */
  navigate(path: string, options?: { replace?: boolean; back?: boolean }): void;
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
  /**
   * Show the person one of this plugin's own proposals, to decide in Korsi's own form, filled in
   * with it: `action.create`, `case.create` (Korsi's new-case form), `case.stage.move` (the case's
   * advance form, aimed at the proposed stage), `case.change`, `calendar.event.create` and
   * `decision.candidate`. Saving accepts it with their edits; `{ reject: true }` asks them to turn
   * it down. How it ended -- `case_id`, `decision_id` or `action_id` naming what saving made -- or
   * null when closed undecided.
   *
   * Absent from a Korsi older than this package (one of {@link OPTIONAL_BRIDGE_FUNCTIONS}): check
   * before offering it, and send the person to Korsi's inbox there instead.
   */
  openProposal?(
    proposalId: string,
    options?: { reject?: boolean }
  ): Promise<DecidedProposal | null>;
  /**
   * Korsi's own file picker: the person uploads from their device into their «فایل‌های من», or
   * picks files they have (`files.read`, ADR-0085). Korsi hands every file picked to this
   * installation before answering. `[]` when they closed it. Optional (plugin API 1.2).
   */
  pickFile?(options?: PickFileOptions): Promise<PickedFile[]>;
  /**
   * Move Korsi's shell to one of Korsi's own pages: a meeting's page (its "enter the room" button
   * is there, not the room itself), a case, a decision, an action. The page applies the person's
   * visibility as always. The frame is left behind, so
   * nothing comes back. Optional (plugin API 1.2).
   */
  showInKorsi?(page: KorsiPageRef): void;
  /**
   * Move Korsi's shell to this installation's own app at `path` -- relative to the app's root,
   * starting with `/` -- from a panel (a desk widget, a record or live panel) or from the app.
   * Never another installation's app. Optional (plugin API 1.2).
   */
  openApp?(path: string): void;
  /**
   * Called with the live room's state, for a `meeting.live.panel` frame (`korsi:meeting.live`).
   * A listener added late is called at once with the latest state and every line so far; later
   * calls carry only new or changed lines -- merge them by `id`. A page that reloads inside its
   * frame is sent everything again. Returns an unsubscribe. Optional (plugin API 1.2).
   */
  onMeetingLive?(listener: (live: MeetingLive) => void): () => unknown;
  /**
   * Ask Korsi to give the plugin's server its credential again: the server answered the page
   * `409 { code: 'plugin.unprovisioned' }`, having restarted with nothing kept (ADR-0086). Korsi
   * shows «در حال آماده‌سازی» over the frame meanwhile and resolves once the credential is back --
   * sending `korsi:init` again with a new handle -- or rejects when it will not (the installation
   * is no longer shown to the person; a wait that ran out rejects with `timeout`). `createPluginApi`
   * does this by itself. Optional (plugin API 1.2).
   */
  renewCredential?(): Promise<void>;
  /**
   * Tell Korsi what the person is looking at on the app's page -- a record's name, «مراحل استخدام ·
   * مدیر محصول» (`korsi:title { title }`). Korsi's status bar shows it over the app's name, as it
   * names its own pages. Plain text: put on one line, trimmed and cut to 120 characters; null or
   * empty clears it, and the bar names the app alone. Heard from the installation's own app page
   * only; a panel's is ignored.
   *
   * Korsi lets it go when the page moves to another screen and names nothing new within a moment,
   * and when the person leaves the app: say it again after each move, Korsi's or the page's own
   * (`@korsi/plugin-react`'s `useKorsiTitle` does). Nothing comes back. Optional: an older Korsi
   * has no title to show.
   */
  setTitle?(title: string | null): void;
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

/**
 * Functions a newer Korsi adds. The loader does not require them, so a page keeps working when an
 * older Korsi frames it; the page checks for each before offering what needs it.
 */
export const OPTIONAL_BRIDGE_FUNCTIONS = Object.freeze([
  'openProposal',
  'pickFile',
  'showInKorsi',
  'openApp',
  'onMeetingLive',
  'renewCredential',
  'setTitle',
] as const satisfies ReadonlyArray<keyof KorsiBridge>);
