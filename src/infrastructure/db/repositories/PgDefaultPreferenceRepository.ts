import { eq, and } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema';
import { IDefaultPreferenceRepository } from '../../../domain/repositories/IDefaultPreferenceRepository';
import { DefaultPreference } from '../../../domain/entities/DefaultPreference';
import { Channel, NotificationType } from '../../../domain/types';

type DbSchema = typeof schema;

export class PgDefaultPreferenceRepository implements IDefaultPreferenceRepository {
  constructor(private readonly db: NodePgDatabase<DbSchema>) {}

  async findAll(): Promise<DefaultPreference[]> {
    const rows = await this.db.select().from(schema.defaultPreferences);
    return rows.map((row) => this.mapPref(row));
  }

  async findOne(type: NotificationType, channel: Channel): Promise<DefaultPreference | null> {
    const rows = await this.db
      .select()
      .from(schema.defaultPreferences)
      .where(
        and(
          eq(schema.defaultPreferences.notificationType, type),
          eq(schema.defaultPreferences.channel, channel),
        ),
      )
      .limit(1);

    return rows.length > 0 ? this.mapPref(rows[0]) : null;
  }

  private mapPref(row: typeof schema.defaultPreferences.$inferSelect): DefaultPreference {
    return {
      notificationType: row.notificationType as NotificationType,
      channel: row.channel as Channel,
      enabled: row.enabled,
    };
  }
}
