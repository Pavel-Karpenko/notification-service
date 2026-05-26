import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/metrics/prometheus', () => ({
  evaluationsTotal: { inc: vi.fn() },
  preferenceUpdatesTotal: { inc: vi.fn() },
  httpDuration: { observe: vi.fn() },
  cacheHitsTotal: { inc: vi.fn() },
  cacheMissesTotal: { inc: vi.fn() },
  registry: { metrics: vi.fn().mockResolvedValue(''), contentType: 'text/plain' },
  collectDefaultMetrics: vi.fn(),
}));

import { EvaluateNotification } from '../../../src/application/use-cases/EvaluateNotification';
import { EvaluationService } from '../../../src/domain/services/EvaluationService';
import { EvaluateResult } from '../../../src/domain/types';
import * as prometheus from '../../../src/infrastructure/metrics/prometheus';

function mockEvaluationService(result: EvaluateResult): EvaluationService {
  return {
    evaluate: vi.fn().mockResolvedValue(result),
  } as unknown as EvaluationService;
}

const BASE_INPUT = {
  userId: 'user-1',
  notificationType: 'marketing_email' as const,
  channel: 'email' as const,
  region: 'EU',
  datetime: new Date('2026-05-21T10:00:00Z'),
};

describe('EvaluateNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Delegates to EvaluationService', () => {
    it('calls evaluationService.evaluate with correct arguments', async () => {
      const service = mockEvaluationService({ decision: 'allow', reason: 'default_preference' });
      const useCase = new EvaluateNotification(service);

      await useCase.execute(BASE_INPUT);

      expect(service.evaluate).toHaveBeenCalledOnce();
      expect(service.evaluate).toHaveBeenCalledWith(BASE_INPUT);
    });

    it('returns the result from evaluationService unchanged', async () => {
      const expected: EvaluateResult = { decision: 'deny', reason: 'blocked_by_global_policy' };
      const useCase = new EvaluateNotification(mockEvaluationService(expected));

      const result = await useCase.execute(BASE_INPUT);

      expect(result).toEqual(expected);
    });
  });

  describe('Metrics recording', () => {
    it('increments evaluationsTotal on allow decision', async () => {
      const useCase = new EvaluateNotification(
        mockEvaluationService({ decision: 'allow', reason: 'default_preference' }),
      );

      await useCase.execute(BASE_INPUT);

      expect(prometheus.evaluationsTotal.inc).toHaveBeenCalledOnce();
      expect(prometheus.evaluationsTotal.inc).toHaveBeenCalledWith({
        decision: 'allow',
        notification_type: 'marketing_email',
        channel: 'email',
        reason: 'default_preference',
      });
    });

    it('increments evaluationsTotal on deny decision', async () => {
      const useCase = new EvaluateNotification(
        mockEvaluationService({ decision: 'deny', reason: 'blocked_by_global_policy' }),
      );

      await useCase.execute(BASE_INPUT);

      expect(prometheus.evaluationsTotal.inc).toHaveBeenCalledWith({
        decision: 'deny',
        notification_type: 'marketing_email',
        channel: 'email',
        reason: 'blocked_by_global_policy',
      });
    });

    it.each([
      ['blocked_by_global_policy', 'deny'],
      ['disabled_by_user', 'deny'],
      ['quiet_hours', 'deny'],
      ['default_preference', 'allow'],
      ['user_preference', 'allow'],
    ] as const)('records correct reason "%s" with decision "%s"', async (reason, decision) => {
      const result: EvaluateResult = decision === 'allow'
        ? { decision: 'allow', reason: reason as 'user_preference' | 'default_preference' }
        : { decision: 'deny', reason: reason as 'blocked_by_global_policy' | 'disabled_by_user' | 'quiet_hours' | 'default_preference' };

      const useCase = new EvaluateNotification(mockEvaluationService(result));

      await useCase.execute(BASE_INPUT);

      expect(prometheus.evaluationsTotal.inc).toHaveBeenCalledWith(
        expect.objectContaining({ decision, reason }),
      );
    });

    it('records correct notification_type and channel labels', async () => {
      const useCase = new EvaluateNotification(
        mockEvaluationService({ decision: 'deny', reason: 'quiet_hours' }),
      );

      await useCase.execute({
        userId: 'user-1',
        notificationType: 'marketing_push',
        channel: 'push',
        region: 'EU',
        datetime: new Date(),
      });

      expect(prometheus.evaluationsTotal.inc).toHaveBeenCalledWith(
        expect.objectContaining({
          notification_type: 'marketing_push',
          channel: 'push',
        }),
      );
    });
  });
});
