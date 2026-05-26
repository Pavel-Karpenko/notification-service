import { DateTime } from 'luxon';

export interface QuietHours {
  userId: string;
  startHour: number;   // 0-23
  startMinute: number; // 0-59
  endHour: number;
  endMinute: number;
  timezone: string;    // IANA timezone name e.g. "Europe/Berlin"
  updatedAt: Date;
}

/**
 * Returns true if the given datetime falls within the quiet hours window.
 * Handles midnight crossover (e.g., 22:00–08:00).
 */
export function isInQuietHours(datetime: Date, qh: QuietHours): boolean {
  const dt = DateTime.fromJSDate(datetime, { zone: qh.timezone });

  const currentMinutes = dt.hour * 60 + dt.minute;
  const startMinutes = qh.startHour * 60 + qh.startMinute;
  const endMinutes = qh.endHour * 60 + qh.endMinute;

  if (startMinutes === endMinutes) {
    // Zero-length window — never quiet
    return false;
  }

  if (startMinutes < endMinutes) {
    // Normal range: e.g., 08:00–22:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Midnight crossover: e.g., 22:00–08:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}
