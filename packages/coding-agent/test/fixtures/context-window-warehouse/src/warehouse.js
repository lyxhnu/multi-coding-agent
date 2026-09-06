import { FileEventStore } from './file-event-store.js';
import { DomainError } from './errors.js';

const copy = (value) => structuredClone(value);
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} must be a non-empty string`);
  return value.trim();
};
const quantity = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new DomainError('INVALID_ARGUMENT', 'quantity must be a positive safe integer');
  return value;
};
const dateString = (value, current) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new DomainError('INVALID_ARGUMENT', 'expiresAt must be a valid ISO timestamp');
  const date = new Date(value);
  if (date <= current) throw new DomainError('INVALID_ARGUMENT', 'expiresAt must be after now');
  return date.toISOString();
};

export class WarehouseService {
  static async open({ eventFile, now = () => new Date() }) {
    const store = new FileEventStore(eventFile);
    await store.init();
    const service = new WarehouseService(store, now);
    await service.rebuild();
    return service;
  }

  constructor(store, now) {
    this.store = store; this.now = now; this.inventory = new Map(); this.reservations = new Map();
    this.commands = new Map(); this.audit = []; this.queue = Promise.resolve();
  }

  async rebuild() {
    for (const event of await this.store.readAll()) {
      this.apply(event);
      this.audit.push(copy(event));
      if (event.commandId && event.commandArgs !== undefined && !this.commands.has(event.commandId)) {
        this.commands.set(event.commandId, { name: event.commandName, args: event.commandArgs, result: event.commandResult });
      }
    }
  }

  apply(event) {
    if (event.type === 'stock_received') {
      const item = this.inventory.get(event.sku) ?? { sku: event.sku, onHand: 0, reserved: 0 };
      item.onHand += event.quantity; this.inventory.set(event.sku, item);
    } else if (event.type === 'reservation_created') {
      this.reservations.set(event.reservation.reservationId, copy(event.reservation));
      for (const line of event.reservation.lines) this.changeReserved(line.sku, line.quantity);
    } else if (event.type === 'reservation_committed') {
      const reservation = this.reservations.get(event.reservationId); reservation.status = 'committed';
      for (const line of reservation.lines) { const item = this.inventory.get(line.sku); item.onHand -= line.quantity; item.reserved -= line.quantity; }
    } else if (event.type === 'reservation_cancelled' || event.type === 'reservation_expired') {
      const reservation = this.reservations.get(event.reservationId); reservation.status = event.type === 'reservation_cancelled' ? 'cancelled' : 'expired';
      for (const line of reservation.lines) this.changeReserved(line.sku, -line.quantity);
    }
  }

  changeReserved(sku, amount) { const item = this.inventory.get(sku) ?? { sku, onHand: 0, reserved: 0 }; item.reserved += amount; this.inventory.set(sku, item); }
  enqueue(work) { const operation = this.queue.then(work); this.queue = operation.catch(() => {}); return operation; }

  async execute(name, args, events, result) {
    const existing = this.commands.get(args.commandId);
    if (existing) {
      if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'commandId was already used with different arguments');
      return copy(existing.result);
    }
    const stored = await this.store.append(events.map((event, index) => index === 0 ? { ...event, commandId: args.commandId, commandName: name, commandArgs: copy(args), commandResult: copy(result) } : event));
    for (const event of stored) { this.apply(event); this.audit.push(copy(event)); }
    this.commands.set(args.commandId, { name, args: copy(args), result: copy(result) });
    return copy(result);
  }

  async receiveStock(command) { return this.enqueue(async () => { const args = { commandId: text(command.commandId, 'commandId'), sku: text(command.sku, 'sku'), quantity: quantity(command.quantity) }; const item = this.inventory.get(args.sku) ?? { sku: args.sku, onHand: 0, reserved: 0 }; const result = { ...item, onHand: item.onHand + args.quantity, available: item.onHand + args.quantity - item.reserved }; return this.execute('receive', args, [{ type: 'stock_received', sku: args.sku, quantity: args.quantity }], result); }); }

  async createReservation(command) { return this.enqueue(async () => {
    const args = { commandId: text(command.commandId, 'commandId'), reservationId: text(command.reservationId, 'reservationId'), expiresAt: dateString(command.expiresAt, new Date(this.now())), lines: normalizeLines(command.lines) };
    this.checkIdempotency('reserve', args);
    if (this.reservations.has(args.reservationId)) throw new DomainError('RESERVATION_ID_EXISTS', 'reservationId is already in use');
    const shortages = args.lines.map((line) => ({ ...line, available: this.available(line.sku) })).filter((line) => line.available < line.quantity).map(({ sku, quantity: requested, available }) => ({ sku, requested, available }));
    if (shortages.length) throw new DomainError('INSUFFICIENT_STOCK', 'Insufficient stock', { shortages });
    const result = { reservationId: args.reservationId, status: 'active', lines: args.lines, expiresAt: args.expiresAt };
    return this.execute('reserve', args, [{ type: 'reservation_created', reservation: result }], result);
  }); }

  async transition(name, command, type) { return this.enqueue(async () => { const args = { commandId: text(command.commandId, 'commandId'), reservationId: text(command.reservationId, 'reservationId') }; const reservation = this.reservations.get(args.reservationId); if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found'); if (reservation.status !== 'active') throw new DomainError('INVALID_RESERVATION_STATE', 'Reservation is not active'); const result = { ...reservation, status: type === 'reservation_committed' ? 'committed' : 'cancelled' }; return this.execute(name, args, [{ type, reservationId: args.reservationId }], result); }); }
  commitReservation(command) { return this.transition('commit', command, 'reservation_committed'); }
  cancelReservation(command) { return this.transition('cancel', command, 'reservation_cancelled'); }

  async expireDue(command) { return this.enqueue(async () => { const date = new Date(command.now ?? this.now()); if (Number.isNaN(date.getTime())) throw new DomainError('INVALID_ARGUMENT', 'now must be a valid date'); const args = { commandId: text(command.commandId, 'commandId'), now: date.toISOString() }; this.checkIdempotency('expire', args); const due = [...this.reservations.values()].filter((r) => r.status === 'active' && new Date(r.expiresAt) <= date).sort((a, b) => a.reservationId.localeCompare(b.reservationId)); const result = due.map((r) => ({ ...r, status: 'expired' })); const events = due.length ? due.map((r) => ({ type: 'reservation_expired', reservationId: r.reservationId })) : [{ type: 'command_completed' }]; return this.execute('expire', args, events, result); }); }

  checkIdempotency(name, args) {
    const existing = this.commands.get(args.commandId);
    if (!existing) return;
    if (existing.name !== name || JSON.stringify(existing.args) !== JSON.stringify(args)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'commandId was already used with different arguments');
    throw new ReplayResult(existing.result);
  }
  available(sku) { const item = this.inventory.get(sku); return item ? item.onHand - item.reserved : 0; }
  getInventory(sku) { const normalized = text(sku, 'sku'); const item = this.inventory.get(normalized) ?? { sku: normalized, onHand: 0, reserved: 0 }; return { ...item, available: item.onHand - item.reserved }; }
  getReservation(id) { const item = this.reservations.get(text(id, 'reservationId')); if (!item) throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found'); return copy(item); }
  getAuditLog() { return copy(this.audit); }
}

function normalizeLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new DomainError('INVALID_ARGUMENT', 'lines must not be empty');
  const totals = new Map();
  for (const line of lines) { const sku = text(line?.sku, 'sku'); const amount = quantity(line?.quantity); totals.set(sku, (totals.get(sku) ?? 0) + amount); }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([sku, amount]) => ({ sku, quantity: amount }));
}
