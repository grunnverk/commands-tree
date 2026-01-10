import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        env: {
            TZ: 'America/New_York'
        },
        // Vitest 4: pool options are now top-level
        pool: 'forks',
        maxForks: 2,
        minForks: 1,
        // Add test timeout and memory limits
        testTimeout: 30000,
        hookTimeout: 10000,
        teardownTimeout: 10000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', 'html'],
            all: true,
            include: ['src/**/*.ts'],
            thresholds: {
                statements: 0,
                branches: 0,
                functions: 0,
                lines: 0,
            }
        },
    },
});
