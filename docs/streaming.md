# Server-Sent Events

`GET /v1/events/stream` is a long-lived `text/event-stream` that fans the domain
event bus out to authenticated clients. It is implemented in `src/streaming`.

```
GET /v1/events/stream
Authorization: Bearer <access token>
Last-Event-ID: 0f8c1a2b3d4e5f60718293a4b5c6d7e8.41   (optional)
```

```
event: stream.open
id: 0f8c1a2b3d4e5f60718293a4b5c6d7e8.41
retry: 3000
data: {"epoch":"0f8c…d7e8","cursor":"0f8c…d7e8.41","resumed":true,"replayed":2,"gap":null}

event: user.registered
id: 0f8c1a2b3d4e5f60718293a4b5c6d7e8.42
data: {"id":"9c1…","name":"user.registered","occurredAt":"2026-08-31T09:14:02.113Z","correlationId":null,"payload":{"userId":"…","email":"…","name":null,"provider":null}}

event: stream.heartbeat
id: 0f8c1a2b3d4e5f60718293a4b5c6d7e8.42

```

## Why SSE and not WebSockets

The stream is one-directional and carries text the client already knows how to
parse. SSE gets reconnection, a resume protocol and proxy compatibility from the
browser for free, over ordinary HTTP that every load balancer, WAF and CDN in the
path already understands. A WebSocket buys full duplex, which nothing here needs,
in exchange for owning reconnection and heartbeating yourself. `SPEC.md` carries
a WebSocket gateway as the next item, for the case that does need it.

## Frames

The SSE event type of a domain-event frame **is the domain event's name**, so a
client subscribes to what it cares about and never demultiplexes a `data` field
by hand:

```js
source.addEventListener("user.registered", (e) => handle(JSON.parse(e.data)));
```

Three control frames are namespaced under `stream.`, a prefix no event name uses
— `stream-frames.ts` makes a collision a compile error rather than a convention.

| Frame              | Visible to `EventSource`? | Purpose                                                               |
| ------------------ | ------------------------- | --------------------------------------------------------------------- |
| `stream.open`      | yes                       | Always first: the epoch, the cursor, the resume verdict, and `retry:` |
| `stream.heartbeat` | **no**                    | Keeps the connection warm and the cursor current                      |
| `stream.closing`   | yes                       | The process is shutting down; this was not the network                |

### The invisible heartbeat

An idle SSE connection is indistinguishable from a dead one to every
intermediary between the client and this process, and they close it — 60s for
nginx's `proxy_read_timeout` and an AWS ALB's idle timeout, 30s for some CDNs.
`SSE_HEARTBEAT_INTERVAL_MS` defaults to a quarter of the tightest of those, so a
connection survives losing two keep-alives to a blip.

The usual keep-alive is an SSE comment (`: keep-alive`), which Nest cannot emit —
`SseStream` renders `MessageEvent` fields and nothing else. The heartbeat here is
a frame with an `id` and **no `data:` line**, which is better than a comment
rather than a workaround for one. From the specification's "dispatch the event"
algorithm: step 1 sets the client's last event ID from the `id` buffer, and step
2 returns _without dispatching_ when the data buffer is empty. So the frame
reaches the socket, fires no handler, and refreshes the resume cursor on the way
past — which a comment does not.

The alternative, a `heartbeat` event carrying a payload, would put "ignore this
one" into the wire contract of every client that ever connects.

## Resume

`EventSource` reconnects on its own and replays its last event ID in the
`Last-Event-ID` header. A server that ignores that header silently drops
everything that happened during the gap.

A cursor is `<epoch>.<seq>`. `seq` is a position in **this process's** stream;
`epoch` is a per-process identity minted at boot. The epoch is the whole reason
the cursor is not just a number: a bare position from a client that reconnected
onto a different replica, or onto this one after a restart, would be honoured
against an unrelated sequence, and the client would be replayed events it never
missed while never learning about the ones it did. Being unable to resume is
survivable. Believing you resumed when you did not is not.

Every connection is therefore told what happened, in the `gap` field of
`stream.open`:

| `gap`              | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `null`             | Resumed cleanly, or a first connection              |
| `malformed-cursor` | Not a cursor this build issues                      |
| `epoch-changed`    | A different process — a restart, or another replica |
| `buffer-evicted`   | Older than the replay window still holds            |
| `cursor-ahead`     | Ahead of anything this process has issued           |

Anything but `null` means events may have been missed: refetch whatever state
you derive from the stream rather than assume you are merely behind.

A client that cannot set a request header — which is every browser using a plain
`EventSource`, on the connection it opens itself — can pass the cursor as
`?lastEventId=`. The header wins where both are present.

## The replay buffer

`ReplayBuffer` is a fixed-size ring in this process's memory, sized by
`SSE_REPLAY_BUFFER_SIZE`. Bounded by construction rather than swept, because
nothing can ever decide an event has been seen by "every client" when the next
client may connect tomorrow asking for history.

**It is counted in events, not seconds.** Memory stays bounded whatever the
event rate does, but the resumable _window_ shrinks as traffic rises — the
opposite of what an operator expects from something called a replay buffer. Size
it against the reconnection gap you want to cover at peak:

```
SSE_REPLAY_BUFFER_SIZE ≈ peak events/sec × seconds of disconnection to survive
```

At 20 events/sec, the 1,024 default covers about 50 seconds — comfortably more
than the `SSE_RETRY_HINT_MS` reconnection, and not much more. At 200 events/sec
it covers five, and most reconnections will come back with `buffer-evicted`.

## Who sees what

Administrators receive the whole catalogue; every other caller receives only
events about their own account (`stream-visibility.ts`). This is not tidiness:
`user.registered` carries an email address and the bus carries every
registration in the process, so a stream without the filter would hand every
authenticated caller the address of everyone who signs up, in real time. Replay
is filtered by the same rule, so the leak cannot be reached by reconnecting
either.

Adding an event to `DomainEventPayloads` stops `stream-visibility.ts` compiling
until somebody decides who may see it. That is deliberate: defaulting to deny
would be safe but silent, and the omission would surface months later as a
support ticket about an event that never arrives.

## Authentication, and the token that is not in the query string

The endpoint takes a bearer token like every other. Browsers cannot set headers
on an `EventSource`, so a browser client needs a fetch-based polyfill
(`@microsoft/fetch-event-source`, `event-source-polyfill`) or a session cookie.

Accepting `?token=` would make an `EventSource` work directly, and it is not
offered. A query string is written to the access log of every proxy in the path,
kept in browser history, and sent in `Referer` — so the credential ends up in
several places that outlive the request, and one of them is a log aggregator
whose retention nobody chose with credentials in mind. `?lastEventId=` is in the
query string because a cursor is not a secret.

## Cross-replica behaviour

`EventStreamHub` is an ordinary bus subscriber, and `DomainEventConsumer` puts
what it reads off the Kafka topic onto the same bus — so an event produced by
another instance reaches a client here indistinguishably from a local one, and
nothing in `src/streaming` mentions a broker.

Replay does **not** cross replicas: the buffer and its sequence are per process.
A client reconnecting through a load balancer usually lands somewhere else and
is told `epoch-changed`. Making resume survive that means a durable log with a
global ordering — the transactional outbox is the obvious candidate, at the cost
of a database read on every reconnect and a decision about how long to retain
published rows. That is a different feature, and it is not this one.

## Shutdown

`onApplicationShutdown` sends `stream.closing` to every open stream and completes
them. Without it, shutdown would wait on connections designed never to end — each
holds a heartbeat timer that keeps the event loop alive — until the ten-second
force-exit in `main.ts` killed the process, taking whatever else was still
draining with it.

## Limits

- **Connections are capped** by `SSE_MAX_CONNECTIONS`; over it is a 503, which a
  load balancer can shed to another replica. SSE connections are held rather than
  served and released, so nothing else in the request path bounds them: without
  the cap the limit is the file-descriptor table, and the failure is the process
  refusing connections of every kind rather than this endpoint refusing new
  subscribers.
- **The access log lands at disconnect, not at connect.** `LoggingInterceptor`
  writes in `finalize`, so a stream appears in the log once, when it ends, with
  its whole lifetime as `latencyMs`. A dashboard reading that field as request
  latency will show this route as the slowest thing in the system.
- **No per-user connection limit.** The cap is global, so one client opening
  connections in a loop can exhaust it for everybody. The throttler bounds the
  rate of new connections, not the number held.
- **No backpressure policy.** Nest writes frames through a `concatMap` that waits
  for `drain`, so a slow reader slows its own stream rather than the process —
  but nothing drops frames or disconnects a client that never reads, and the
  events queue in that connection's operator chain until it does.
- **Replay is not durable.** See "Cross-replica behaviour".

## Configuration

| Variable                    | Default | Meaning                                |
| --------------------------- | ------- | -------------------------------------- |
| `SSE_HEARTBEAT_INTERVAL_MS` | 15000   | Keep-alive interval for an idle stream |
| `SSE_REPLAY_BUFFER_SIZE`    | 1024    | Events retained for resume             |
| `SSE_MAX_CONNECTIONS`       | 1000    | Simultaneous streams before 503        |
| `SSE_RETRY_HINT_MS`         | 3000    | `retry:` sent to clients               |
