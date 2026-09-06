import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError } from './errors.js';

export class FileEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(this.filePath, '', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async readAll() {
    const text = await readFile(this.filePath, 'utf8');
    if (text.length === 0) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = index + 1;
      if (!lines[index].trim()) throw new DomainError('CORRUPT_EVENT_LOG', 'Blank event log line', { line });
      let event;
      try { event = JSON.parse(lines[index]); } catch { throw new DomainError('CORRUPT_EVENT_LOG', 'Invalid JSON in event log', { line }); }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new DomainError('CORRUPT_EVENT_LOG', 'Event must be an object', { line });
      }
      if (event.seq !== events.length + 1) throw new DomainError('CORRUPT_EVENT_LOG', 'Unexpected event sequence', { line });
      events.push(event);
    }
    return events;
  }

  async append(events) {
    if (!events.length) return [];
    const operation = this.queue.then(async () => {
      const current = await this.readAll();
      const stored = events.map((event, index) => ({
        ...event,
        seq: current.length + index + 1,
        recordedAt: new Date().toISOString(),
      }));
      await appendFile(this.filePath, `${stored.map((event) => JSON.stringify(event)).join('\n')}\n`);
      return stored;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
