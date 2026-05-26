import { EvaluationService } from '../../domain/services/EvaluationService';
import { Channel, EvaluateResult, NotificationType } from '../../domain/types';
import { evaluationsTotal } from '../../infrastructure/metrics/prometheus';

export interface EvaluateNotificationInput {
  userId: string;
  notificationType: NotificationType;
  channel: Channel;
  region: string;
  datetime: Date;
}

export class EvaluateNotification {
  constructor(private readonly evaluationService: EvaluationService) {}

  async execute(input: EvaluateNotificationInput): Promise<EvaluateResult> {
    const result = await this.evaluationService.evaluate(input);

    evaluationsTotal.inc({
      decision: result.decision,
      notification_type: input.notificationType,
      channel: input.channel,
      reason: result.reason,
    });

    return result;
  }
}
