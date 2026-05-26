import { eq, and } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema';
import { IUserPreferenceRepository } from '../../../domain/repositories/IUserPreferenceRepository';
import { UserPreference } from '../../../domain/entities/UserPreference';
import { QuietHours } from '../../../domain/entities/QuietHours';
import { Channel, NotificationType } from '../../../domain/types';

type DbSchema = typeof schema;

export class PgUserPreferenceRepository implements IUserPreferenceRepository {
  constructor(private readonly db: NodePgDatabase<DbSchema>) {}

  async findByUserId(userId: string): Promise<UserPreference[]> {
    const rows = await this.db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, userId));

    return rows.map((row) => this.mapPref(row));
  }

  async findOne(
    userId: string,
    type: NotificationType,
    channel: Channel,
  ): Promise<UserPreference | null> {
    const rows = await this.db
      .select()
      .from(schema.userPreferences)
      .where(
        and(
          eq(schema.userPreferences.userId, userId),
          eq(schema.userPreferences.notificationType, type),
          eq(schema.userPreferences.channel, channel),
        ),
      )
      .limit(1);

    return rows.length > 0 ? this.mapPref(rows[0]) : null;
  }

  async upsert(pref: Omit<UserPreference, 'updatedAt'>): Promise<UserPreference> {
    const rows = await this.db
      .insert(schema.userPreferences)
      .values({
        userId: pref.userId,
        notificationType: pref.notificationType,
        channel: pref.channel,
        enabled: pref.enabled,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.userPreferences.userId,
          schema.userPreferences.notificationType,
          schema.userPreferences.channel,
        ],
        set: {
          enabled: pref.enabled,
          updatedAt: new Date(),
        },
      })
      .returning();

    return this.mapPref(rows[0]);
  }

  async findQuietHours(userId: string): Promise<QuietHours | null> {
    const rows = await this.db
      .select()
      .from(schema.quietHours)
      .where(eq(schema.quietHours.userId, userId))
      .limit(1);

    if (rows.length === 0) return null;
    return this.mapQuietHours(rows[0]);
  }

  async upsertQuietHours(qh: Omit<QuietHours, 'updatedAt'>): Promise<QuietHours> {
    const rows = await this.db
      .insert(schema.quietHours)
      .values({
        userId: qh.userId,
        startHour: qh.startHour,
        startMinute: qh.startMinute,
        endHour: qh.endHour,
        endMinute: qh.endMinute,
        timezone: qh.timezone,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.quietHours.userId,
        set: {
          startHour: qh.startHour,
          startMinute: qh.startMinute,
          endHour: qh.endHour,
          endMinute: qh.endMinute,
          timezone: qh.timezone,
          updatedAt: new Date(),
        },
      })
      .returning();

    return this.mapQuietHours(rows[0]);
  }

  private mapPref(row: typeof schema.userPreferences.$inferSelect): UserPreference {
    return {
      userId: row.userId,
      notificationType: row.notificationType as NotificationType,
      channel: row.channel as Channel,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    };
  }

  private mapQuietHours(row: typeof schema.quietHours.$inferSelect): QuietHours {
    return {
      userId: row.userId,
      startHour: row.startHour,
      startMinute: row.startMinute,
      endHour: row.endHour,
      endMinute: row.endMinute,
      timezone: row.timezone,
      updatedAt: row.updatedAt,
    };
  }
}
