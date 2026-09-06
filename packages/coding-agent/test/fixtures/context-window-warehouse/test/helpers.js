import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function tempEventFile() {
  const directory = await mkdtemp(join(tmpdir(), 'warehouse-service-'));
  return join(directory, 'events.jsonl');
}

export async function readEventLines(file) {
  const text = await readFile(file, 'utf8');
  return text === '' ? [] : text.trimEnd().split('\n').map(JSON.parse);
}

export function fixedClock(iso = '2030-01-01T10:00:00.000Z') {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    set(next) {
      value = new Date(next);
    },
  };
}
