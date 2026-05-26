import type { FastifyPluginAsync } from 'fastify';
import { NOTIFICATION_TYPES, CHANNELS } from '../../domain/types';
import type { NotificationType, Channel } from '../../domain/types';
import type { EvaluateNotification } from '../../application/use-cases/EvaluateNotification';

interface EvaluateRouteOptions {
  evaluateNotification: EvaluateNotification;
}

interface EvaluateBody {
  userId: string;
  notificationType: NotificationType;
  channel: Channel;
  region: string;
  datetime: string;
}

const evaluateRoutes: FastifyPluginAsync<EvaluateRouteOptions> = async (fastify, opts) => {
  fastify.post<{ Body: EvaluateBody }>(
    '/evaluate',
    {
      schema: {
        tags: ['Evaluation'],
        summary: 'Evaluate whether a notification should be sent',
        description:
          'Runs the evaluation cascade: global policy → user preference → quiet hours → default. Returns allow/deny with a reason.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['userId', 'notificationType', 'channel', 'region', 'datetime'],
          properties: {
            userId: { type: 'string', minLength: 1, description: 'Recipient user identifier' },
            notificationType: {
              type: 'string',
              enum: [...NOTIFICATION_TYPES],
              description: 'Type of notification to evaluate',
            },
            channel: {
              type: 'string',
              enum: [...CHANNELS],
              description: 'Delivery channel',
            },
            region: {
              type: 'string',
              minLength: 1,
              description: 'ISO region code (EU, US, APAC, LATAM, OTHER) or custom',
            },
            datetime: {
              type: 'string',
              format: 'date-time',
              description: 'ISO 8601 datetime for the evaluation (used for quiet hours check)',
            },
          },
        },
        response: {
          200: {
            description: 'Evaluation result',
            type: 'object',
            required: ['decision', 'reason'],
            properties: {
              decision: { type: 'string', enum: ['allow', 'deny'] },
              reason: {
                type: 'string',
                enum: [
                  'blocked_by_global_policy',
                  'disabled_by_user',
                  'quiet_hours',
                  'user_preference',
                  'default_preference',
                ],
              },
            },
          },
          400: {
            description: 'Invalid request body',
            type: 'object',
            properties: {
              statusCode: { type: 'number' },
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          401: {
            description: 'Missing or invalid JWT token',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      try {
        const result = await opts.evaluateNotification.execute({
          userId: body.userId,
          notificationType: body.notificationType,
          channel: body.channel,
          region: body.region,
          datetime: new Date(body.datetime),
        });

        return reply.status(200).send(result);
      } catch (err) {
        request.log.error(
          { err, userId: body.userId, requestId: request.requestId },
          'Failed to evaluate notification',
        );
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
};

export default evaluateRoutes;
