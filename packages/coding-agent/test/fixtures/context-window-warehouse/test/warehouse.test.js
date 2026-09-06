import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/errors.js';
import { WarehouseService } from '../src/warehouse.js';
import { fixedClock, readEventLines, tempEventFile } from './helpers.js';

async function setup() {
  const eventFile = await tempEventFile();
  const clock = fixedClock();
  const service = await WarehouseService.open({ eventFile, now: clock.now });
  return { eventFile, clock, service };
}

test('receives stock and reports unknown inventory as zero', async () => {
  const { service } = await setup();
  assert.deepEqual(service.getInventory('missing'), { sku: 'missing', onHand: 0, reserved: 0, available: 0 });
  const result = await service.receiveStock({ commandId: 'receive-1', sku: '  A-1  ', quantity: 12 });
  assert.deepEqual(result, { sku: 'A-1', onHand: 12, reserved: 0, available: 12 });
  assert.deepEqual(service.getInventory('A-1'), result);
});

test('normalizes reservation lines and reserves atomically', async () => {
  const { service } = await setup();
  await service.receiveStock({ commandId: 'r-a', sku: 'A', quantity: 10 });
  await service.receiveStock({ commandId: 'r-b', sku: 'B', quantity: 4 });
  const reservation = await service.createReservation({
    commandId: 'reserve-1',
    reservationId: 'order-7',
    expiresAt: '2030-01-01T10:15:00.000Z',
    lines: [
      { sku: 'B', quantity: 1 },
      { sku: ' A ', quantity: 2 },
      { sku: 'A', quantity: 3 },
    ],
  });
  assert.deepEqual(reservation, {
    reservationId: 'order-7',
    status: 'active',
    lines: [{ sku: 'A', quantity: 5 }, { sku: 'B', quantity: 1 }],
    expiresAt: '2030-01-01T10:15:00.000Z',
  });
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 10, reserved: 5, available: 5 });
  assert.deepEqual(service.getInventory('B'), { sku: 'B', onHand: 4, reserved: 1, available: 3 });
});

test('reports every shortage in sorted order and leaves state unchanged', async () => {
  const { eventFile, service } = await setup();
  await service.receiveStock({ commandId: 'receive-a', sku: 'A', quantity: 2 });
  const before = await readEventLines(eventFile);
  await assert.rejects(
    () => service.createReservation({
      commandId: 'reserve-short',
      reservationId: 'short',
      expiresAt: '2030-01-01T11:00:00.000Z',
      lines: [{ sku: 'Z', quantity: 3 }, { sku: 'A', quantity: 5 }],
    }),
    (error) => {
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      assert.deepEqual(error.details, {
        shortages: [
          { sku: 'A', requested: 5, available: 2 },
          { sku: 'Z', requested: 3, available: 0 },
        ],
      });
      return true;
    },
  );
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 2, reserved: 0, available: 2 });
  assert.deepEqual(await readEventLines(eventFile), before);
});

test('commits, cancels, and rejects transitions from terminal states', async () => {
  const { service } = await setup();
  await service.receiveStock({ commandId: 'receive', sku: 'A', quantity: 8 });
  await service.createReservation({ commandId: 'reserve-1', reservationId: 'one', expiresAt: '2030-01-01T11:00:00.000Z', lines: [{ sku: 'A', quantity: 3 }] });
  const committed = await service.commitReservation({ commandId: 'commit-1', reservationId: 'one' });
  assert.equal(committed.status, 'committed');
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 5, reserved: 0, available: 5 });
  await assert.rejects(() => service.cancelReservation({ commandId: 'cancel-too-late', reservationId: 'one' }), { code: 'INVALID_RESERVATION_STATE' });

  await service.createReservation({ commandId: 'reserve-2', reservationId: 'two', expiresAt: '2030-01-01T11:00:00.000Z', lines: [{ sku: 'A', quantity: 2 }] });
  const cancelled = await service.cancelReservation({ commandId: 'cancel-2', reservationId: 'two' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 5, reserved: 0, available: 5 });
  await assert.rejects(() => service.commitReservation({ commandId: 'commit-too-late', reservationId: 'two' }), { code: 'INVALID_RESERVATION_STATE' });
});

test('expires due reservations in ID order and releases stock', async () => {
  const { clock, service } = await setup();
  await service.receiveStock({ commandId: 'receive', sku: 'A', quantity: 10 });
  await service.createReservation({ commandId: 'reserve-z', reservationId: 'z-last', expiresAt: '2030-01-01T10:05:00.000Z', lines: [{ sku: 'A', quantity: 2 }] });
  await service.createReservation({ commandId: 'reserve-a', reservationId: 'a-first', expiresAt: '2030-01-01T10:10:00.000Z', lines: [{ sku: 'A', quantity: 3 }] });
  await service.createReservation({ commandId: 'reserve-future', reservationId: 'future', expiresAt: '2030-01-01T12:00:00.000Z', lines: [{ sku: 'A', quantity: 1 }] });
  clock.set('2030-01-01T10:10:00.000Z');
  const expired = await service.expireDue({ commandId: 'expire-1', now: '2030-01-01T10:10:00.000Z' });
  assert.deepEqual(expired.map((item) => item.reservationId), ['a-first', 'z-last']);
  assert(expired.every((item) => item.status === 'expired'));
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 10, reserved: 1, available: 9 });
});

test('successful commands are idempotent and conflicting reuse is rejected', async () => {
  const { eventFile, service } = await setup();
  const first = await service.receiveStock({ commandId: 'same', sku: 'A', quantity: 5 });
  first.onHand = 999;
  const count = (await readEventLines(eventFile)).length;
  const replay = await service.receiveStock({ commandId: 'same', sku: ' A ', quantity: 5 });
  assert.deepEqual(replay, { sku: 'A', onHand: 5, reserved: 0, available: 5 });
  assert.equal((await readEventLines(eventFile)).length, count);
  await assert.rejects(() => service.receiveStock({ commandId: 'same', sku: 'A', quantity: 6 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(() => service.cancelReservation({ commandId: 'same', reservationId: 'missing' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('failed commands may be retried with the same command ID after state changes', async () => {
  const { service } = await setup();
  const command = { commandId: 'retry-me', reservationId: 'order', expiresAt: '2030-01-01T11:00:00.000Z', lines: [{ sku: 'A', quantity: 2 }] };
  await assert.rejects(() => service.createReservation(command), { code: 'INSUFFICIENT_STOCK' });
  await service.receiveStock({ commandId: 'receive', sku: 'A', quantity: 2 });
  assert.equal((await service.createReservation(command)).status, 'active');
});

test('state and idempotency survive restart using only the event log', async () => {
  const { eventFile, clock, service } = await setup();
  await service.receiveStock({ commandId: 'receive', sku: 'A', quantity: 9 });
  await service.createReservation({ commandId: 'reserve', reservationId: 'order', expiresAt: '2030-01-01T11:00:00.000Z', lines: [{ sku: 'A', quantity: 4 }] });
  const restarted = await WarehouseService.open({ eventFile, now: clock.now });
  assert.deepEqual(restarted.getInventory('A'), { sku: 'A', onHand: 9, reserved: 4, available: 5 });
  assert.equal(restarted.getReservation('order').status, 'active');
  const before = (await readEventLines(eventFile)).length;
  assert.deepEqual(await restarted.receiveStock({ commandId: 'receive', sku: 'A', quantity: 9 }), { sku: 'A', onHand: 9, reserved: 4, available: 5 });
  assert.equal((await readEventLines(eventFile)).length, before);
});

test('read models are defensive copies', async () => {
  const { service } = await setup();
  await service.receiveStock({ commandId: 'receive', sku: 'A', quantity: 3 });
  await service.createReservation({ commandId: 'reserve', reservationId: 'order', expiresAt: '2030-01-01T11:00:00.000Z', lines: [{ sku: 'A', quantity: 1 }] });
  const inventory = service.getInventory('A');
  const reservation = service.getReservation('order');
  const audit = service.getAuditLog();
  inventory.onHand = 100;
  reservation.lines[0].quantity = 100;
  audit[0].type = 'tampered';
  assert.deepEqual(service.getInventory('A'), { sku: 'A', onHand: 3, reserved: 1, available: 2 });
  assert.equal(service.getReservation('order').lines[0].quantity, 1);
  assert.notEqual(service.getAuditLog()[0].type, 'tampered');
});

test('validates command fields with stable domain errors', async () => {
  const { service } = await setup();
  for (const command of [
    { commandId: '', sku: 'A', quantity: 1 },
    { commandId: 'x', sku: '', quantity: 1 },
    { commandId: 'x', sku: 'A', quantity: 0 },
    { commandId: 'x', sku: 'A', quantity: 1.5 },
  ]) {
    await assert.rejects(() => service.receiveStock(command), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT');
  }
  await assert.rejects(() => service.createReservation({ commandId: 'r1', reservationId: 'r', expiresAt: 'not-a-date', lines: [{ sku: 'A', quantity: 1 }] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => service.createReservation({ commandId: 'r2', reservationId: 'r', expiresAt: '2030-01-01T10:00:00.000Z', lines: [{ sku: 'A', quantity: 1 }] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => service.commitReservation({ commandId: 'c', reservationId: 'missing' }), { code: 'RESERVATION_NOT_FOUND' });
});
