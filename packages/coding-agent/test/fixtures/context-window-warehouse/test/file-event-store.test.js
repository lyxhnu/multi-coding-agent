import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import { DomainError } from '../src/errors.js';
import { FileEventStore } from '../src/file-event-store.js';
import { tempEventFile } from './helpers.js';

test('init creates nested parent directories and an empty file', async () => {
  const file = await tempEventFile();
  const nested = `${dirname(file)}/one/two/events.jsonl`;
  const store = new FileEventStore(nested);
  await store.init();
  await store.init();
  assert.deepEqual(await store.readAll(), []);
});

test('append assigns contiguous sequence numbers and timestamps', async () => {
  const file = await tempEventFile();
  const store = new FileEventStore(file);
  await store.init();
  const first = await store.append([
    { type: 'one', commandId: 'a' },
    { type: 'two', commandId: 'a' },
  ]);
  const second = await store.append([{ type: 'three', commandId: 'b' }]);
  assert.deepEqual(first.map((event) => event.seq), [1, 2]);
  assert.deepEqual(second.map((event) => event.seq), [3]);
  for (const event of [...first, ...second]) {
    assert.equal(new Date(event.recordedAt).toISOString(), event.recordedAt);
  }
  assert.deepEqual(await store.readAll(), [...first, ...second]);
});

test('concurrent appends remain whole and ordered', async () => {
  const file = await tempEventFile();
  const store = new FileEventStore(file);
  await store.init();
  const batches = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.append([
        { type: 'batch-start', commandId: `cmd-${index}`, index },
        { type: 'batch-end', commandId: `cmd-${index}`, index },
      ]),
    ),
  );
  const events = await store.readAll();
  assert.equal(events.length, 40);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 40 }, (_, index) => index + 1));
  for (const batch of batches) {
    assert.equal(batch[1].seq, batch[0].seq + 1);
  }
});

test('empty append changes nothing', async () => {
  const file = await tempEventFile();
  const store = new FileEventStore(file);
  await store.init();
  assert.deepEqual(await store.append([]), []);
  assert.deepEqual(await store.readAll(), []);
});

for (const [name, contents, line] of [
  ['blank line', '{"seq":1,"type":"ok"}\n\n', 2],
  ['invalid JSON', '{"seq":1,"type":"ok"}\n{broken}\n', 2],
  ['non-object', '{"seq":1,"type":"ok"}\n42\n', 2],
  ['wrong sequence', '{"seq":1,"type":"ok"}\n{"seq":3,"type":"skip"}\n', 2],
]) {
  test(`readAll rejects ${name} as corruption`, async () => {
    const file = await tempEventFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
    const store = new FileEventStore(file);
    await assert.rejects(
      () => store.readAll(),
      (error) => error instanceof DomainError && error.code === 'CORRUPT_EVENT_LOG' && error.details.line === line,
    );
  });
}

test('append refuses to extend a corrupt log', async () => {
  const file = await tempEventFile();
  const store = new FileEventStore(file);
  await store.init();
  await appendFile(file, 'not-json\n');
  await assert.rejects(() => store.append([{ type: 'nope' }]), { code: 'CORRUPT_EVENT_LOG' });
});
