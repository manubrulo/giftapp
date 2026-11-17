import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoggerOptions } from './logging.js';

test('logger uses environment-specific defaults and accepts LOG_LEVEL overrides', () => {
  assert.equal(createLoggerOptions('test'), false);
  assert.equal((createLoggerOptions('production') as { level: string }).level, 'info');
  assert.equal((createLoggerOptions('development') as { level: string }).level, 'debug');
  assert.equal((createLoggerOptions('production', 'warn') as { level: string }).level, 'warn');
  assert.throws(() => createLoggerOptions('production', 'verbose'), /Invalid LOG_LEVEL/);
});

test('request serializer omits query strings and sensitive headers are redacted', () => {
  const options = createLoggerOptions('production') as {
    serializers: { req: (request: { id: string; method: string; url: string }) => Record<string, unknown> };
    redact: { paths: string[] };
  };
  assert.deepEqual(options.serializers.req({ id: 'r1', method: 'GET', url: '/api/items?token=secret' }), {
    id: 'r1', method: 'GET', url: '/api/items',
  });
  assert.ok(options.redact.paths.includes('req.headers.cookie'));
  assert.ok(options.redact.paths.includes('req.headers.authorization'));
});
