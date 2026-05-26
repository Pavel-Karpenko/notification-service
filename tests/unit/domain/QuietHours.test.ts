import { describe, it, expect } from 'vitest';
import { isInQuietHours, QuietHours } from '../../../src/domain/entities/QuietHours';

function makeQH(
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  timezone: string,
): QuietHours {
  return {
    userId: 'test-user',
    startHour,
    startMinute,
    endHour,
    endMinute,
    timezone,
    updatedAt: new Date(),
  };
}

describe('isInQuietHours', () => {
  describe('midnight crossover (22:00 - 08:00)', () => {
    const qh = makeQH(22, 0, 8, 0, 'Europe/Berlin');

    it('should return true at 23:00 (inside quiet hours)', () => {
      // 23:00 Berlin time on a given day
      const dt = new Date('2026-05-20T21:00:00Z'); // 23:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return true at 03:00 (inside quiet hours after midnight)', () => {
      // 03:00 Berlin time
      const dt = new Date('2026-05-21T01:00:00Z'); // 03:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return false at 10:00 (outside quiet hours)', () => {
      // 10:00 Berlin time
      const dt = new Date('2026-05-21T08:00:00Z'); // 10:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return false at 12:00 (outside quiet hours)', () => {
      // 12:00 Berlin time
      const dt = new Date('2026-05-21T10:00:00Z'); // 12:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return false at exactly end time 08:00', () => {
      // 08:00 Berlin time (end boundary is exclusive)
      const dt = new Date('2026-05-21T06:00:00Z'); // 08:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return true at exactly start time 22:00', () => {
      // 22:00 Berlin time
      const dt = new Date('2026-05-20T20:00:00Z'); // 22:00 Berlin (UTC+2 in summer)
      expect(isInQuietHours(dt, qh)).toBe(true);
    });
  });

  describe('normal range (08:00 - 20:00)', () => {
    const qh = makeQH(8, 0, 20, 0, 'UTC');

    it('should return true at 12:00 UTC (inside)', () => {
      const dt = new Date('2026-05-21T12:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return false at 06:00 UTC (before start)', () => {
      const dt = new Date('2026-05-21T06:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return false at 21:00 UTC (after end)', () => {
      const dt = new Date('2026-05-21T21:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return true at exactly 08:00 (start boundary)', () => {
      const dt = new Date('2026-05-21T08:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return false at exactly 20:00 (end boundary exclusive)', () => {
      const dt = new Date('2026-05-21T20:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });
  });

  describe('with minutes (22:30 - 07:45)', () => {
    const qh = makeQH(22, 30, 7, 45, 'UTC');

    it('should return false at 22:00 (before start with minutes)', () => {
      const dt = new Date('2026-05-20T22:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });

    it('should return true at 22:30 (exactly at start)', () => {
      const dt = new Date('2026-05-20T22:30:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return true at 07:44 (just before end)', () => {
      const dt = new Date('2026-05-21T07:44:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should return false at 07:45 (at end boundary)', () => {
      const dt = new Date('2026-05-21T07:45:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });
  });

  describe('different timezones', () => {
    it('should correctly handle America/New_York timezone', () => {
      const qh = makeQH(22, 0, 8, 0, 'America/New_York');
      // 23:00 NY time = 03:00 UTC (UTC-4 in summer)
      const dt = new Date('2026-05-21T03:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });

    it('should correctly handle Asia/Tokyo timezone', () => {
      const qh = makeQH(22, 0, 8, 0, 'Asia/Tokyo');
      // 23:00 Tokyo = 14:00 UTC (UTC+9)
      const dt = new Date('2026-05-21T14:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(true);
    });
  });

  describe('zero-length window', () => {
    it('should return false if start equals end', () => {
      const qh = makeQH(10, 0, 10, 0, 'UTC');
      const dt = new Date('2026-05-21T10:00:00Z');
      expect(isInQuietHours(dt, qh)).toBe(false);
    });
  });
});
