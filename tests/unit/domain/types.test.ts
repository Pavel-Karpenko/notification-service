import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_TYPES,
  CHANNELS,
  REGIONS,
  isTransactional,
} from '../../../src/domain/types';

describe('NOTIFICATION_TYPES', () => {
  it('contains exactly 6 types', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(6);
  });

  it('contains all transactional types', () => {
    expect(NOTIFICATION_TYPES).toContain('transactional_email');
    expect(NOTIFICATION_TYPES).toContain('transactional_sms');
    expect(NOTIFICATION_TYPES).toContain('transactional_push');
  });

  it('contains all marketing types', () => {
    expect(NOTIFICATION_TYPES).toContain('marketing_email');
    expect(NOTIFICATION_TYPES).toContain('marketing_sms');
    expect(NOTIFICATION_TYPES).toContain('marketing_push');
  });

  it('is a readonly tuple', () => {
    expect(Array.isArray(NOTIFICATION_TYPES)).toBe(true);
  });
});

describe('CHANNELS', () => {
  it('contains exactly 4 channels', () => {
    expect(CHANNELS).toHaveLength(4);
  });

  it('contains email, sms, push, messenger', () => {
    expect(CHANNELS).toContain('email');
    expect(CHANNELS).toContain('sms');
    expect(CHANNELS).toContain('push');
    expect(CHANNELS).toContain('messenger');
  });
});

describe('REGIONS', () => {
  it('contains EU, US, APAC, LATAM, OTHER', () => {
    expect(REGIONS).toContain('EU');
    expect(REGIONS).toContain('US');
    expect(REGIONS).toContain('APAC');
    expect(REGIONS).toContain('LATAM');
    expect(REGIONS).toContain('OTHER');
  });
});

describe('isTransactional', () => {
  it.each([
    ['transactional_email', true],
    ['transactional_sms', true],
    ['transactional_push', true],
    ['marketing_email', false],
    ['marketing_sms', false],
    ['marketing_push', false],
  ] as const)('isTransactional("%s") === %s', (type, expected) => {
    expect(isTransactional(type)).toBe(expected);
  });

  it('returns true for all transactional types', () => {
    const transactional = NOTIFICATION_TYPES.filter((t) => t.startsWith('transactional_'));
    expect(transactional.every(isTransactional)).toBe(true);
  });

  it('returns false for all marketing types', () => {
    const marketing = NOTIFICATION_TYPES.filter((t) => t.startsWith('marketing_'));
    expect(marketing.some(isTransactional)).toBe(false);
  });
});
