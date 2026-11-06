/**
 * `GET /sessions/:id/events?tail=1` — the in-flight turn's persisted events
 * plus the live `running` flag, used by a client that reconnects mid-turn to
 * rebuild the running turn instead of starting from an empty buffer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createStore as createJsonlStore } from '@volto/store-jsonl';
import type { TranscriptEvent } from '@volto/core';
import { createServer, type HeadlessServer } from '../server.js';
import { unfinishedTurnTail } from '../session-tail.js';

const T0 = 1_800_000_000_000;

function ev(type: string, time: number, data: Record<string, unknown> = {}, turn?: number): TranscriptEvent {
  return { seq: 0, sessionId: '', time, type, data, ...(turn !== undefined ? { turn } : {}) } as unknown as TranscriptEvent;
}

describe('unfinishedTurnTail', () => {
  it('returns the slice after the last turn_end', () => {
    const events = [
      ev('turn_start', T0, { turn: 1 }, 1),
      ev('user_message', T0 + 1, { content: 'one' }, 1),
      ev('turn_end', T0 + 2, { turn: 1, reason: 'done' }, 1),
      ev('turn_start', T0 + 3, { turn: 2 }, 2),
      ev('assistant_message', T0 + 4, { content: [] }, 2),
    ];
    expect(unfinishedTurnTail(events).map((e) => e.type)).toEqual([
      'turn_start',
      'assistant_message',
    ]);
  });

  it('is empty when the log ends on a settled turn', () => {
    expect(
      unfinishedTurnTail([ev('turn_start', T0, {}, 1), ev('turn_end', T0 + 1, { reason: 'done' }, 1)]),
    ).toEqual([]);
  });

  it('returns every event when the log never recorded a turn_end', () => {
    const events = [ev('turn_start', T0, {}, 1), ev('assistant_message', T0 + 1, {}, 1)];
    expect(unfinishedTurnTail(events)).toEqual(events);
  });
});

describe('GET /sessions/:id/events?tail=1', () => {
  let server: HeadlessServer;
  let configDir: string;
  let previousConfigDir: string | undefined;
  let store: ReturnType<typeof createJsonlStore>;
  let baseUrl: string;
  let launchToken: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'volto-tail-'));
    previousConfigDir = process.env['VOLTO_CONFIG_DIR'];
    process.env['VOLTO_CONFIG_DIR'] = configDir;
    store = createJsonlStore({ directory: path.join(configDir, 'sessions') });
    server = await createServer({ port: 0, modelPort: { async *stream() {} } });
    launchToken = server.launchToken;
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfigDir === undefined) delete process.env['VOLTO_CONFIG_DIR'];
    else process.env['VOLTO_CONFIG_DIR'] = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function get(pathname: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        new URL(pathname, baseUrl),
        { method: 'GET', agent: false, headers: { Authorization: `Bearer ${launchToken}`, Connection: 'close' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves only the unfinished turn plus running=false for an idle session', async () => {
    const sessionId = `tail-${crypto.randomUUID()}`;
    await store.appendEvents(null, sessionId, [
      { time: T0, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      { time: T0 + 1, type: 'user_message', data: { content: 'first' }, turn: 1 },
      { time: T0 + 2, type: 'turn_end', data: { turn: 1, reason: 'done' }, turn: 1 },
      { time: T0 + 3, type: 'turn_start', data: { turn: 2 }, turn: 2 },
      { time: T0 + 4, type: 'user_message', data: { content: 'second' }, turn: 2 },
    ]);

    const { status, body } = await get(`/sessions/${encodeURIComponent(sessionId)}/events?tail=1`);
    expect(status).toBe(200);
    expect(body['running']).toBe(false);
    expect((body['events'] as Array<{ type: string }>).map((e) => e.type)).toEqual([
      'turn_start',
      'user_message',
    ]);

    const all = await get(`/sessions/${encodeURIComponent(sessionId)}/events`);
    expect((all.body['events'] as unknown[]).length).toBe(5);
  });
});
