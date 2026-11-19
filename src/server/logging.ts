import type { FastifyServerOptions } from 'fastify';

const levels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export function createLoggerOptions(
  nodeEnv = process.env.NODE_ENV,
  configuredLevel = process.env.LOG_LEVEL,
  configuredFormat = process.env.LOG_FORMAT,
): FastifyServerOptions['logger'] {
  if (nodeEnv === 'test') return false;
  const level = configuredLevel || (nodeEnv === 'production' ? 'info' : 'debug');
  if (!levels.has(level)) throw new Error(`Invalid LOG_LEVEL "${level}". Use fatal, error, warn, info, debug, trace, or silent.`);
  const format = configuredFormat || 'pretty';
  if (format !== 'pretty' && format !== 'json') throw new Error(`Invalid LOG_FORMAT "${format}". Use pretty or json.`);
  return {
    level,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-api-key'],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request) {
        return {
          id: request.id,
          method: request.method,
          // Query strings may contain secrets; route and method are sufficient
          // to correlate request logs without recording them.
          url: request.url?.split('?', 1)[0] ?? '/',
        };
      },
    },
    ...(format === 'pretty' ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: Boolean(process.stdout.isTTY),
          translateTime: 'SYS:standard',
          singleLine: true,
          ignore: 'pid,hostname',
        },
      },
    } : {}),
  };
}
