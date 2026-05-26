import type { FastifyPluginAsync } from 'fastify';
import { NOTIFICATION_TYPES, CHANNELS } from '../../domain/types';
import type { NotificationType, Channel } from '../../domain/types';
import type { GetUserPreferences } from '../../application/use-cases/GetUserPreferences';
import type { UpdateUserPreferences } from '../../application/use-cases/UpdateUserPreferences';

interface PreferencesRouteOptions {
  getUserPreferences: GetUserPreferences;
  updateUserPreferences: UpdateUserPreferences;
}

interface UpdatePreference {
  notificationType: NotificationType;
  channel: Channel;
  enabled: boolean;
}

interface QuietHoursInput {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timezone: string;
}

interface UpdateBody {
  preferences?: UpdatePreference[];
  quietHours?: QuietHoursInput;
}

const preferenceItemSchema = {
  type: 'object',
  required: ['notificationType', 'channel', 'enabled', 'source'],
  properties: {
    notificationType: { type: 'string', enum: [...NOTIFICATION_TYPES] },
    channel: { type: 'string', enum: [...CHANNELS] },
    enabled: { type: 'boolean' },
    source: { type: 'string', enum: ['user', 'default'], description: 'Where the value comes from' },
  },
} as const;

const quietHoursSchema = {
  type: 'object',
  required: ['startHour', 'startMinute', 'endHour', 'endMinute', 'timezone'],
  properties: {
    startHour: { type: 'integer', minimum: 0, maximum: 23 },
    startMinute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
    endHour: { type: 'integer', minimum: 0, maximum: 23 },
    endMinute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
    timezone: { type: 'string', minLength: 1, description: 'IANA timezone name (e.g. Europe/Berlin)' },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

const preferencesRoutes: FastifyPluginAsync<PreferencesRouteOptions> = async (fastify, opts) => {
  fastify.get<{ Params: { userId: string } }>(
    '/users/:userId/preferences',
    {
      schema: {
        tags: ['Preferences'],
        summary: 'Get user notification preferences',
        description:
          'Returns the merged view: explicit user overrides take precedence, remaining types fall back to system defaults.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', description: 'User identifier' },
          },
        },
        response: {
          200: {
            description: 'User preferences merged with defaults',
            type: 'object',
            required: ['userId', 'preferences', 'quietHours'],
            properties: {
              userId: { type: 'string' },
              preferences: {
                type: 'array',
                items: preferenceItemSchema,
              },
              quietHours: {
                oneOf: [quietHoursSchema, { type: 'null' }],
                description: 'Active quiet hours window, or null if not configured',
              },
            },
          },
          401: { description: 'Unauthorized', ...errorSchema },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;

      try {
        const result = await opts.getUserPreferences.execute(userId);
        return reply.status(200).send(result);
      } catch (err) {
        request.log.error({ err, userId, requestId: request.requestId }, 'Failed to get user preferences');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  fastify.post<{ Params: { userId: string }; Body: UpdateBody }>(
    '/users/:userId/preferences',
    {
      schema: {
        tags: ['Preferences'],
        summary: 'Update user notification preferences',
        description:
          'Upserts one or more channel preferences and/or sets quiet hours. Idempotent — repeated calls with the same payload produce the same result.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', description: 'User identifier' },
          },
        },
        body: {
          type: 'object',
          properties: {
            preferences: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['notificationType', 'channel', 'enabled'],
                properties: {
                  notificationType: { type: 'string', enum: [...NOTIFICATION_TYPES] },
                  channel: { type: 'string', enum: [...CHANNELS] },
                  enabled: { type: 'boolean' },
                },
              },
            },
            quietHours: quietHoursSchema,
          },
        },
        response: {
          200: {
            description: 'Updated preferences summary',
            type: 'object',
            required: ['userId', 'updatedCount', 'quietHours'],
            properties: {
              userId: { type: 'string' },
              updatedCount: { type: 'integer', description: 'Number of preference rows upserted' },
              quietHours: {
                oneOf: [quietHoursSchema, { type: 'null' }],
              },
            },
          },
          400: { description: 'Validation error', ...errorSchema },
          401: { description: 'Unauthorized', ...errorSchema },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const body = request.body;

      try {
        const result = await opts.updateUserPreferences.execute({
          userId,
          preferences: body.preferences,
          quietHours: body.quietHours,
        });

        return reply.status(200).send({
          userId,
          updatedCount: result.updatedPreferences.length,
          quietHours: result.quietHours,
        });
      } catch (err) {
        request.log.error({ err, userId, requestId: request.requestId }, 'Failed to update user preferences');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
};

export default preferencesRoutes;
