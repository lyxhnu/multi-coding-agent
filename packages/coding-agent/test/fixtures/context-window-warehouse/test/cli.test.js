import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tempEventFile } from './helpers.js';

function runCli(eventFile, commands) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', eventFile], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr, responses: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) });
    });
    child.stdin.end(`${commands.join('\n')}\n`);
  });
}

test('CLI processes successful commands in order and persists between runs', async () => {
  const file = await tempEventFile();
  const first = await runCli(file, [
    JSON.stringify({ op: 'receive', commandId: 'one', sku: 'A', quantity: 7 }),
    JSON.stringify({ op: 'reserve', commandId: 'two', reservationId: 'order', expiresAt: '2999-01-01T00:00:00.000Z', lines: [{ sku: 'A', quantity: 2 }] }),
    JSON.stringify({ op: 'inventory', sku: 'A' }),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.responses.map((item) => item.ok), [true, true, true]);
  assert.deepEqual(first.responses[2].result, { sku: 'A', onHand: 7, reserved: 2, available: 5 });
  const second = await runCli(file, [JSON.stringify({ op: 'reservation', reservationId: 'order' })]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.responses[0].result.status, 'active');
});

test('CLI converts bad input and domain failures into responses without exiting early', async () => {
  const file = await tempEventFile();
  const result = await runCli(file, [
    '{bad json',
    JSON.stringify({ op: 'unknown' }),
    JSON.stringify({ op: 'inventory', sku: 'A' }),
    JSON.stringify({ op: 'commit', commandId: 'commit', reservationId: 'missing' }),
    JSON.stringify({ op: 'audit' }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.responses.map((item) => item.ok), [false, false, true, false, true]);
  assert.equal(result.responses[0].error.code, 'INVALID_COMMAND');
  assert.equal(result.responses[1].error.code, 'INVALID_COMMAND');
  assert.equal(result.responses[3].error.code, 'RESERVATION_NOT_FOUND');
});
