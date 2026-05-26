import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { v4 as uuidv4 } from 'uuid';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

const correlationIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', (request: FastifyRequest, _reply, done) => {
    const requestId = (request.headers['x-request-id'] as string | undefined) ?? uuidv4();
    request.requestId = requestId;
    done();
  });

  fastify.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('x-request-id', request.requestId);
    done();
  });
};

export default fp(correlationIdPlugin);
