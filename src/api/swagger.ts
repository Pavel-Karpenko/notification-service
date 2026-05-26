import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';

const swaggerPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Notification Preferences Service',
        description:
          'Manages user notification preferences and evaluates whether a notification should be delivered based on user settings, global policies, and quiet hours.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Preferences', description: 'User notification preference management' },
        { name: 'Evaluation', description: 'Notification delivery decision engine' },
        { name: 'System', description: 'Health and observability probes' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'HS256 JWT token. Use the /docs "Authorize" button to set it.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });
};

export default fp(swaggerPlugin, { name: 'swagger', fastify: '4.x' });
