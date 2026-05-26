import pino from 'pino';
import { getConfig } from '../../config';

const config = getConfig();

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  base: {
    service: 'notification-service',
    env: config.NODE_ENV,
  },
});

export type Logger = pino.Logger;
