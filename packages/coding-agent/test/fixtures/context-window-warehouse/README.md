# Warehouse Reservation Service

Build a zero-dependency Node.js service that reserves warehouse inventory for checkout flows. The repository contains the public API and acceptance tests, while the implementation is intentionally incomplete.

## Constraints

- Use ECMAScript modules and Node.js built-ins only.
- Persist every state change as one JSON object per line in an append-only JSONL file.
- All mutating commands are idempotent by `commandId`.
- A command must either append all of its events and update state, or do nothing.
- Public methods may be called concurrently. Serialize mutations so stock cannot be oversold.
- Quantities are positive safe integers. IDs and SKUs are non-empty strings after trimming.
- Domain failures throw `DomainError` with a stable `code` and optional `details`.
- Do not weaken or remove acceptance tests.

## Public modules

### `src/errors.js`

Exports `DomainError`. Its constructor accepts `(code, message, details?)` and exposes all three values. `details` is omitted when absent.

### `src/file-event-store.js`

Exports `FileEventStore`:

```js
const store = new FileEventStore('/absolute/path/events.jsonl');
await store.init();
const current = await store.readAll();
const appended = await store.append([
  { type: 'stock_received', commandId: 'cmd-1', sku: 'ABC', quantity: 5 }
]);
```

Rules:

- `init()` creates the parent directory and file if needed. Calling it repeatedly is safe.
- `readAll()` returns parsed events ordered by sequence.
- Stored events add `seq` starting at 1 and an ISO `recordedAt` timestamp.
- `append(events)` serializes concurrent calls, assigns contiguous sequences, writes one batch in one append, and returns the stored event objects.
- If JSONL contains a blank line, invalid JSON, a non-object, or a sequence that is not the expected next integer, throw `DomainError('CORRUPT_EVENT_LOG', ...)` with `{ line }`.
- Never silently repair or truncate a corrupt log.
- An empty append returns `[]` and does not touch the file.

### `src/warehouse.js`

Exports `WarehouseService`:

```js
const warehouse = await WarehouseService.open({ eventFile, now });
await warehouse.receiveStock({ commandId, sku, quantity });
await warehouse.createReservation({ commandId, reservationId, lines, expiresAt });
await warehouse.commitReservation({ commandId, reservationId });
await warehouse.cancelReservation({ commandId, reservationId });
await warehouse.expireDue({ commandId, now });
warehouse.getInventory(sku);
warehouse.getReservation(reservationId);
warehouse.getAuditLog();
```

`now` is an optional function returning a `Date`; default to the current time.

Inventory projection per SKU:

```js
{ sku, onHand, reserved, available }
```

Unknown SKUs report zeros. `available = onHand - reserved`.

Reservation input lines have `{ sku, quantity }`. Normalize SKUs by trimming, aggregate duplicate SKUs, and sort lines lexicographically by SKU before persistence. A reservation snapshot is:

```js
{
  reservationId,
  status: 'active' | 'committed' | 'cancelled' | 'expired',
  lines: [{ sku, quantity }],
  expiresAt
}
```

Rules:

- `receiveStock` increases `onHand`.
- `createReservation` requires at least one valid line and a valid ISO timestamp strictly after `now()`.
- Reservation IDs are globally unique, including cancelled, expired, and committed reservations.
- Creation is atomic: if any SKU lacks availability, throw `INSUFFICIENT_STOCK` with `{ shortages: [{ sku, requested, available }] }`, sorted by SKU. Append no event and reserve nothing.
- Creating an active reservation increases `reserved` for every line.
- `commitReservation` changes an active reservation to committed, decreases both `onHand` and `reserved`, and cannot make either negative.
- `cancelReservation` changes an active reservation to cancelled and decreases `reserved`.
- Committing or cancelling a non-active reservation throws `INVALID_RESERVATION_STATE`.
- Missing reservations throw `RESERVATION_NOT_FOUND`.
- `expireDue` expires all active reservations whose `expiresAt <= now`, releases stock, and returns expired snapshots sorted by reservation ID. Persist one `reservation_expired` event per reservation in that same order.
- Read methods return defensive copies. Callers must not be able to mutate internal state.

Idempotency rules:

- On first success, associate `commandId` with the normalized command name, normalized arguments, emitted sequence numbers, and result.
- Repeating the same command with the same normalized arguments returns an equivalent defensive copy and appends no events.
- Reusing a `commandId` for another command or different normalized arguments throws `IDEMPOTENCY_CONFLICT` and appends no events.
- Domain failures are not recorded as successful commands; callers may retry the same `commandId` after correcting state.
- Idempotency must survive process restart using only the event log.

Persist enough data in each event to rebuild inventory, reservations, and successful command results. The exact event shape beyond required fields is your choice; do not add a second database or sidecar file.

### `src/cli.js`

Run with:

```sh
node src/cli.js /path/to/events.jsonl
```

Read newline-delimited JSON commands from stdin and write one JSON response per input line to stdout, preserving order. Supported `op` values map to the service methods: `receive`, `reserve`, `commit`, `cancel`, `expire`, `inventory`, `reservation`, and `audit`.

Success response:

```json
{"ok":true,"result":{}}
```

Domain failure response:

```json
{"ok":false,"error":{"code":"...","message":"...","details":{}}}
```

Malformed JSON and unknown operations use code `INVALID_COMMAND`. One bad line must not terminate the process. Unexpected failures may terminate with a non-zero exit code and a diagnostic on stderr.

## Completion

Implement the system, run `npm test` and `npm run check`, and leave the project in a passing state. Summarize the behavior and verification when done.
