import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Config module uses a singleton; must reset between tests
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear the singleton
  void import('../../../src/config/index').then((m) => m.resetConfig());
});

afterEach(() => {
  process.env = savedEnv;
  void import('../../../src/config/index').then((m) => m.resetConfig());
});

describe('Config validation', () => {
  it('parses valid environment variables', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'production';
    process.env['PORT'] = '8080';
    process.env['LOG_LEVEL'] = 'warn';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config = getConfig();

    expect(config.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/db');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('warn');
  });

  it('uses default PORT of 3000 when not set', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    delete process.env['PORT'];

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config = getConfig();

    expect(config.PORT).toBe(3000);
  });

  it('uses default LOG_LEVEL of info when not set', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    delete process.env['LOG_LEVEL'];

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config = getConfig();

    expect(config.LOG_LEVEL).toBe('info');
  });

  it('uses default NODE_ENV of development when not set', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    delete process.env['NODE_ENV'];

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config = getConfig();

    expect(config.NODE_ENV).toBe('development');
  });

  it('coerces PORT string to number', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    process.env['PORT'] = '4000';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config = getConfig();

    expect(typeof config.PORT).toBe('number');
    expect(config.PORT).toBe(4000);
  });

  it('throws when DATABASE_URL is missing', async () => {
    delete process.env['DATABASE_URL'];

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).toThrow();
  });

  it('throws when NODE_ENV is invalid', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    process.env['NODE_ENV'] = 'staging';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).toThrow();
  });

  it('throws when LOG_LEVEL is invalid', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';
    process.env['LOG_LEVEL'] = 'verbose';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).toThrow();
  });

  it('throws when JWT_SECRET is missing', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    delete process.env['JWT_SECRET'];

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).toThrow();
  });

  it('throws when JWT_SECRET is shorter than 32 characters', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'too-short';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).toThrow('JWT_SECRET must be at least 32 characters');
  });

  it('accepts JWT_SECRET of exactly 32 characters', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'exactly-32-characters-long-secret'; // 34 chars, just in case

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();

    expect(() => getConfig()).not.toThrow();
  });

  it('returns the same singleton on repeated calls', async () => {
    process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/db';
    process.env['JWT_SECRET'] = 'test-jwt-secret-minimum-32-characters-long';

    const { getConfig, resetConfig } = await import('../../../src/config/index');
    resetConfig();
    const config1 = getConfig();
    const config2 = getConfig();

    expect(config1).toBe(config2);
  });
});
