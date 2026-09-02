export { RealtimeModule } from "./realtime.module";
export {
  MAX_INBOUND_FRAME_BYTES,
  REALTIME_PATH,
  RealtimeGateway,
  realtimeOptionsFrom,
} from "./realtime.gateway";
export type { RealtimeOptions } from "./realtime.gateway";
export { RealtimeCloseCode } from "./close-codes";
export type { RealtimeCloseCodeValue } from "./close-codes";
export { BackpressuredSocket } from "./backpressured-socket";
export type { BackpressureOptions, SendOutcome } from "./backpressured-socket";
export { ConnectionRegistry } from "./connection-registry";
export type { RealtimeConnection } from "./connection-registry";
export { authenticateHandshake, readHandshakeCredentials } from "./handshake";
export type {
  CredentialLookup,
  CredentialSource,
  HandshakeCredentials,
  HandshakeRejection,
  HandshakeResult,
} from "./handshake";
export { SOCKET_OPEN, systemRealtimeClock } from "./ports";
export type {
  HandshakeRequest,
  HandshakeTokenVerifier,
  RealtimeClock,
  RealtimeSocket,
} from "./ports";
export {
  REALTIME_CONTROL_EVENTS,
  closingFrame,
  domainEventFrame,
  errorFrame,
  laggedFrame,
  subscribedFrame,
  unsubscribedFrame,
  welcomeFrame,
} from "./realtime-frames";
export type {
  RealtimeClosingPayload,
  RealtimeControlEvent,
  RealtimeErrorCode,
  RealtimeErrorPayload,
  RealtimeFrame,
  RealtimeLaggedPayload,
  RealtimeSubscriptionPayload,
  RealtimeWelcomePayload,
} from "./realtime-frames";
export { canJoin, defaultRoomsFor, eventRoom, parseRoom, roomsFor, userRoom } from "./rooms";
export type { EventRoom, RoomName, UserRoom } from "./rooms";
