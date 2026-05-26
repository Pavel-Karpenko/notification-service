import { eq, and, or } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../schema';
import { IGlobalPolicyRepository } from '../../../domain/repositories/IGlobalPolicyRepository';
import { GlobalPolicy } from '../../../domain/entities/GlobalPolicy';
import { Channel, NotificationType } from '../../../domain/types';

type DbSchema = typeof schema;

export class PgGlobalPolicyRepository implements IGlobalPolicyRepository {
  constructor(private readonly db: NodePgDatabase<DbSchema>) {}

  async findBlocking(
    type: NotificationType,
    channel: Channel,
    region: string,
  ): Promise<GlobalPolicy | null> {
    // Check for a 'deny' policy matching this type+channel+region or type+channel+'*'
    const rows = await this.db
      .select()
      .from(schema.globalPolicies)
      .where(
        and(
          eq(schema.globalPolicies.notificationType, type),
          eq(schema.globalPolicies.channel, channel),
          eq(schema.globalPolicies.action, 'deny'),
          or(
            eq(schema.globalPolicies.region, region),
            eq(schema.globalPolicies.region, '*'),
          ),
        ),
      )
      .limit(1);

    return rows.length > 0 ? this.mapPolicy(rows[0]) : null;
  }

  async findAll(): Promise<GlobalPolicy[]> {
    const rows = await this.db.select().from(schema.globalPolicies);
    return rows.map((row) => this.mapPolicy(row));
  }

  async upsert(policy: Omit<GlobalPolicy, 'id' | 'createdAt'>): Promise<GlobalPolicy> {
    const id = uuidv4();
    const rows = await this.db
      .insert(schema.globalPolicies)
      .values({
        id,
        notificationType: policy.notificationType,
        channel: policy.channel,
        region: policy.region,
        action: policy.action,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.globalPolicies.notificationType,
          schema.globalPolicies.channel,
          schema.globalPolicies.region,
        ],
        set: {
          action: policy.action,
        },
      })
      .returning();

    return this.mapPolicy(rows[0]);
  }

  private mapPolicy(row: typeof schema.globalPolicies.$inferSelect): GlobalPolicy {
    return {
      id: row.id,
      notificationType: row.notificationType as NotificationType,
      channel: row.channel as Channel,
      region: row.region,
      action: row.action as 'allow' | 'deny',
      createdAt: row.createdAt,
    };
  }
}
