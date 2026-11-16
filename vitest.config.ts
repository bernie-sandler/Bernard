import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Thin discord.js glue and process wiring: exercised against a real Discord gateway, not unit tests.
      exclude: [
        'src/index.ts',
        'src/logger.ts',
        'src/db/migrate-cli.ts',
        'src/discord/adapters.ts',
        'src/discord/voiceAdapter.ts',
        'src/bot/client.ts',
        'src/bot/register.ts',
        'src/bot/interactions.ts',
        'src/bot/events/**',
        'src/jobs/index.ts',
      ],
      reporter: ['text-summary', 'html'],
    },
  },
});
