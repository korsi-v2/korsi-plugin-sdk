/**
 * Korsi's Bridge for a plugin's page: the protocol's types, finding and loading the runtime from
 * the Korsi that frames the page, and calling the plugin's own server as the person.
 *
 *     import { connectKorsi } from '@korsi/bridge';
 *     const korsi = await connectKorsi({ allowedOrigins: ['https://acme.korsi.ai'] });
 *     if (korsi) {
 *       const { bridge, context } = korsi; // context.theme, context.locale, context.user ...
 *       const handle = await bridge.getHandle();
 *     }
 */
export {
  BRIDGE_FUNCTIONS,
  MESSAGES,
  OPTIONAL_BRIDGE_FUNCTIONS,
  PROTOCOL,
  type BridgeErrorCode,
  type ConfirmQuestion,
  type ConnectOptions,
  type DecidedProposal,
  type KorsiBridge,
  type KorsiContext,
  type KorsiHandle,
  type KorsiPalette,
  type KorsiRecordContext,
  type KorsiTheme,
  type MessageName,
  type MessageType,
  type PickedCase,
  type PickedPerson,
  type ToastKind,
} from './protocol.js';
export {
  BridgeTrustError,
  BridgeVersionError,
  bridgeUrl,
  connectKorsi,
  isFramed,
  korsiOrigin,
  loadBridge,
  normaliseOrigin,
  originAllowed,
  type ConnectKorsiOptions,
  type ImportModule,
  type KorsiConnection,
} from './loader.js';
export {
  createPluginApi,
  INSTALLATION_HEADER,
  PluginApiError,
  type PluginApi,
  type PluginApiOptions,
} from './api.js';
