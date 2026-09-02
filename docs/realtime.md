# WebSockets

`wss://…/v1/realtime` is a duplex channel that fans the domain event bus out to
authenticated clients and lets them change what they are subscribed to without
reconnecting. It is implemented in `src/realtime`.

```
GET /v1/realtime
Upgrade: websocket
Authorization: Bearer <access token>
```

```jsonc
// server → client, immediately after the upgrade
{"event":"realtime.welcome","data":{"connectionId":"9c1…","userId":"clx…","role":"USER","rooms":["user:clx…"],"heartbeatIntervalMs":30000,"limits":{"maxRooms":64,"sendHighWaterMarkBytes":1048576}}}

// client → server
{"event":"subscribe","data":{"rooms":["events:user.registered"]}}

// server → client
{"event":"realtime.subscribed","data":{"rooms":["events:user.registered"],"allRooms":["user:clx…","events:user.registered"]}}
{"event":"user.registered","data":{"id":"…","name":"user.registered","occurredAt":"2026-09-02T09:14:02.113Z","correlationId":null,"payload":{"userId":"…","email":"…","name":null,"provider":null}}}
```

Every frame in both directions is `{ event, data }`. That is not a preference:
it is the shape `WsAdapter` parses an inbound frame into before dispatching it
to a `@SubscribeMessage` handler, and using it outbound too means a domain-event
frame is indexed by exactly the name a client subscribed to — the same property
the SSE endpoint gets from putting the event name on the `event:` line. The
`data` of a domain-event frame is `StreamEventPayload`, imported from
`src/streaming` rather than redeclared, so a client moving between the two
transports changes how it connects and nothing about how it reads an event.

## When to use this instead of SSE

`docs/streaming.md` argues that `GET /v1/events/stream` is the right default,
and it still is. SSE gets reconnection, a resume protocol and proxy
compatibility from the browser for free, over ordinary HTTP that every load
balancer, WAF and CDN in the path already understands.

Use this when the client must **send** as well as receive. Changing a
subscription over SSE means tearing the connection down and reopening it with
different query parameters; here it is a frame. If your client only ever
listens, and listens to the same thing for the life of the connection, SSE is
less to operate and less to get wrong.

What you give up by choosing this:

|                    | SSE                                     | this gateway                       |
| ------------------ | --------------------------------------- | ---------------------------------- |
| Reconnect          | `EventSource`, automatic, with `retry:` | yours to write                     |
| Resume after a gap | `Last-Event-ID` + a replay buffer       | **none** — see below               |
| Liveness           | server-sent heartbeat frames            | protocol ping/pong                 |
| Proxy support      | ordinary HTTP responses                 | needs `Upgrade` allowed end to end |
| Browser auth       | needs a fetch-based polyfill            | `Sec-WebSocket-Protocol`           |

**There is no resume.** A client that reconnects gets whatever happens next and
nothing it missed. This is a deliberate omission rather than an oversight: the
replay buffer in `src/streaming` is keyed to a cursor the SSE protocol carries
for free, and bolting an equivalent onto this gateway would mean inventing a
cursor, a resume frame and an eviction verdict — the whole of `stream-cursor.ts`
and `replay-buffer.ts` again — for a transport whose reconnection story is
already the client's to write. A client that cannot tolerate a gap should
refetch on connect, which is what `realtime.lagged` tells it to do anyway.

## Authentication happens after the upgrade

A Nest guard runs on `@SubscribeMessage` handlers. It never runs on the
handshake. A gateway that relies on guards therefore accepts every socket that
reaches it and only asks who it belongs to when it sends a message — which a
socket that never sends one never does, so it sits there authenticated by
nobody, holding a file descriptor.

Rejecting _before_ the upgrade is not available either. `WsAdapter` calls
`handleUpgrade` itself from its own `upgrade` listener, so `ws`'s `verifyClient`
hook is never consulted.

What is left is what `RealtimeGateway.handleConnection` does: verify
synchronously, before the socket is registered or placed in any room, and close
it if verification fails. Synchronously is the part that matters — an `await`
between the upgrade and the close is a window in which an unauthenticated socket
exists and can send frames, so `authenticateHandshake` uses `JwtService.verify`
rather than `verifyAsync`.

The consolation is that the client learns more than an HTTP 401 would have told
it. A browser cannot read the status line of a failed WebSocket handshake, but
it can read `CloseEvent.code`:

| Code   | Meaning                                            | What the client should do              |
| ------ | -------------------------------------------------- | -------------------------------------- |
| `4401` | No usable credentials, or the token did not verify | Get a new access token, then reconnect |
| `4403` | The token verified but is not an access token      | Stop; this will not fix itself         |
| `4408` | Slow consumer — see backpressure below             | Reconnect, and read faster             |
| `4429` | This process is at `WS_MAX_CONNECTIONS`            | Back off and retry, ideally elsewhere  |
| `1001` | The process is shutting down                       | Reconnect through the load balancer    |

### Getting a token onto the handshake from a browser

The `WebSocket` constructor cannot set headers. Its second argument can:

```js
const socket = new WebSocket("wss://api.example.com/v1/realtime", ["bearer", accessToken]);
```

That becomes `Sec-WebSocket-Protocol: bearer, <token>`, `ws` echoes the first
offered subprotocol back, and the connection completes. The token is in a
header, not in a URL.

**A token in the query string is refused**, with the distinct close reason
`token-in-query` so the mistake names itself in a log. A query string is written
to every access log, proxy log and browser history entry on the path, and unlike
a header it survives in `Referer`. `docs/streaming.md` refuses it on the SSE
route for the same reason; there the refusal costs a browser client a polyfill,
here it costs nothing at all.

## Rooms

Two forms, and only two:

| Room                  | Contents                       | Who may join                      |
| --------------------- | ------------------------------ | --------------------------------- |
| `user:<id>`           | Every event about that account | That account, or an administrator |
| `events:<event name>` | Every occurrence of that event | Administrators                    |

A connection starts in `user:<own id>`, so a client that only wants its own
events never sends a frame at all.

**A room is an interest filter, never a permission.** This is the single most
important sentence in the module. Membership decides which connections a
fan-out has to _consider_; whether a given event may actually be written to one
of them is decided, every time, by `isVisibleTo` — the same exhaustive rule the
SSE endpoint uses, in the same file. Two authorisation paths that must agree are
two authorisation paths that eventually will not, and the one that drifts is
always the newer one.

So `canJoin` is doing something else. It keeps the registry's reverse index from
filling with rooms whose traffic the subscriber could never be shown, and it
turns "subscribed successfully, then silence" — the most confusing failure a
pub/sub client can hit — into an immediate `realtime.error`. Delivery is pinned
from the other side in `realtime.gateway.spec.ts`: membership is forced directly
into the registry for a room the caller could never have joined, and nothing is
written.

The reverse index is why rooms exist as a data structure rather than as a
predicate. Without it, delivering one `user.registered` means walking every open
connection and asking each whether it cares — a thousand questions for an event
that concerns one person.

Both `subscribe` and `unsubscribe` are all-or-nothing: one bad room refuses the
whole frame. Applying half of it would leave the client's idea of its own
subscription and the server's disagreeing, which is the bug this protocol is
least able to help anyone debug. The `allRooms` field on every acknowledgement
exists so a client never has to reconstruct that state from deltas.

Leaving a room is always allowed, including a room the caller could no longer
join. A membership that a role change has made unjoinable must still be
escapable without reconnecting.

## Backpressure

`socket.send()` on a peer that has stopped reading does not block and does not
fail. It appends to an in-process buffer, and `bufferedAmount` grows. Nothing in
`ws`, in Node, or in the kernel ever pushes back — so a broadcast loop writes
just as eagerly to the one connection behind a stalled mobile radio as to the
ninety-nine that are keeping up.

The arithmetic is unforgiving. At 200 events/second and a 2 KB payload, one peer
that stops reading for a minute is 24 MB of heap that nothing will reclaim until
it disconnects. A handful of them is the process.

Three policies were available:

- **Buffer anyway.** One client's network decides everyone's availability.
- **Close immediately over the mark.** `bufferedAmount` spikes over any
  threshold during an ordinary burst — a client that is reading perfectly well
  is simply a round trip behind — so this disconnects healthy clients under
  exactly the load where staying connected matters most.
- **Drop, then close if it persists.** What `BackpressuredSocket` does.

Over `WS_SEND_HIGH_WATER_MARK_BYTES`, events stop being written and are counted.
If the peer drains back under **half** that — a low-water mark, so a connection
hovering at the threshold does not flap between states and emit a refetch
instruction on every other event — the connection recovers and is told what it
missed:

```jsonc
{
  "event": "realtime.lagged",
  "data": { "dropped": 37, "since": "2026-09-02T09:14:02.113Z", "refetchRequired": true },
}
```

If it is still over the mark when `WS_SLOW_CONSUMER_GRACE_MS` has elapsed, it is
closed with `4408`. At that point it is not a burst, and a connection that
cannot be delivered to is not a connection.

Dropping is only acceptable because the client is _told_, in the same vocabulary
the SSE endpoint uses for the same situation — `stream.open`'s `gap` field says
"you may have missed events, refetch". Silent loss is what makes dropping
unacceptable, not loss itself. Anything that genuinely may not be lost travels
through the outbox and the Kafka topic, which are durable; this is a view onto
them, not a delivery guarantee.

Control frames go through the same budget. An acknowledgement written past the
high-water mark is another kilobyte on a buffer that is already the problem, and
there is nothing a client can do with a `realtime.subscribed` it will not read
for a minute. The one exception is the shutdown farewell, which is written
unconditionally because the process is going away in milliseconds and the buffer
it adds to will not outlive it.

## Liveness

One `setInterval` for the whole process, at `WS_HEARTBEAT_INTERVAL_MS`, does two
jobs:

1. **Ping every connection**, and terminate one that did not answer the previous
   ping. A WebSocket that has lost its peer is invisible at the application
   layer — no events are due, nothing is written, and the operating system may
   hold the TCP connection open for hours. `terminate()` rather than `close()`,
   because a close handshake waits for a reply from exactly the peer that is not
   replying.
2. **Re-examine every lagging connection.** Otherwise the grace window is only
   ever checked on the next send, and a connection that falls behind during a
   burst usually goes quiet the moment the burst passes — so it would hold its
   slot and its buffered megabytes indefinitely.

One timer rather than one per socket: with a thousand connections that is one
timer instead of a thousand. It is `unref()`ed, for the same reason the SSE
heartbeat is — a timer that holds the event loop open turns every graceful
shutdown into the force-exit in `main.ts`.

## Shutdown

The farewell is sent from `beforeApplicationShutdown`, and the choice of hook is
the whole of it. `NestApplicationContext.close()` runs destroy hooks, then
`beforeApplicationShutdown`, then `dispose()`, then `onApplicationShutdown`.
`dispose()` is where `SocketModule.close()` calls `terminate()` on every client:
no close frame, no code, nothing a client can tell apart from the network
failing. `EventStreamHub` does its equivalent work in `onApplicationShutdown`,
correctly — an SSE response is not a socket the socket module owns — but a
gateway that copied it would find every WebSocket already gone.

So each connection is sent `{"event":"realtime.closing","data":{"reason":"shutdown"}}`
and closed with `1001`, and a client can tell an orderly deploy from a dropped
connection.

## Wiring

The gateway is inert without an adapter:

```ts
app.useWebSocketAdapter(new WsAdapter(app)); // before app.init()
```

Nest's default is socket.io, which this project does not install, so a missing
line is a boot failure rather than a quietly dead endpoint. `main.ts` and
`test/helpers/create-test-app.ts` both set it, and `WsAdapter` shares the HTTP
server, so `/v1/realtime` upgrades on the same port as every REST route.

`RealtimeGateway` is an ordinary class provider with injected dependencies,
where `StreamingModule` binds its hub through a `useFactory`. That is not a
style inconsistency: `SocketModule` finds gateways by reading
`Reflect.getMetadataKeys` off each provider's `metatype`, and a `useFactory`
provider's metatype is the factory function — a gateway constructed that way is
silently never connected to a server.

`AuthModule` re-exports `JwtModule` so the gateway verifies handshakes with the
same `JwtService` that signed the token. A second `JwtModule.registerAsync` here
would be a second place the secret and the signing options are configured, and
the failure when they drift is an access token this API issues that its own
gateway rejects.

## Settings

| Variable                        | Default   | Notes                                                                                                                      |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `WS_MAX_CONNECTIONS`            | `1000`    | Separate from `SSE_MAX_CONNECTIONS`: a socket also carries a send buffer, so one connection costs far more than one stream |
| `WS_MAX_ROOMS_PER_CONNECTION`   | `64`      | A memory bound — an administrator may join any `user:<id>` room, and each name is a key held for the connection's life     |
| `WS_SEND_HIGH_WATER_MARK_BYTES` | `1048576` | ~500 events at this application's payload sizes; recovery is at half of it                                                 |
| `WS_SLOW_CONSUMER_GRACE_MS`     | `10000`   | Long enough for a mobile radio handover, short enough that a wedged client is not still holding a megabyte a minute later  |
| `WS_HEARTBEAT_INTERVAL_MS`      | `30000`   | Ping interval and pong deadline; also paces the lagging-connection sweep                                                   |

The largest frame a client may send is a constant (16 KiB in
`realtime.gateway.ts`), not a setting. It is a property of the protocol rather
than of a deployment — the only messages this gateway accepts are `subscribe`
and `unsubscribe` — and `ws` enforces it before the frame is buffered, which is
the only place it _can_ be enforced: by the time a handler sees a message, the
memory has already been allocated.

## Operating it

`Upgrade` must be allowed end to end. An ALB needs no special configuration; an
nginx in the path needs `proxy_http_version 1.1` and the `Upgrade`/`Connection`
headers forwarded, and its `proxy_read_timeout` must exceed
`WS_HEARTBEAT_INTERVAL_MS`.

Two log lines are worth alerting on. `missed a heartbeat — terminating` in bulk
means the path between clients and this process is dropping connections rather
than that clients are misbehaving. `closed after dropping N frame(s)` is the
backpressure policy doing its job, and a rising rate means either the event rate
has outgrown what clients can consume or `WS_SEND_HIGH_WATER_MARK_BYTES` is set
below a legitimate burst.

The endpoint does not appear in Swagger. OpenAPI 3.1 has no vocabulary for a
WebSocket channel, and a `GET /v1/realtime` entry describing an upgrade would be
a lie a generated client would try to call. This file is the specification.
