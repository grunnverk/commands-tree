import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@eldrforge/core';

// Mock dependencies
vi.mock('@eldrforge/core', () => ({
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
}));

vi.mock('@eldrforge/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '', stderr: '' })),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

vi.mock('@eldrforge/commands-git', () => ({
    findAllPackageJsonFiles: vi.fn(() => [
        { path: '/project/package.json' }
    ]),
    batchReadPackageJsonFiles: vi.fn(() => [
        { path: '/project/package.json', content: { name: '@test/pkg', version: '1.0.0' } }
    ]),
}));

vi.mock('@eldrforge/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0", "dependencies": {"lodash": "^4.0.0"}}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
        exists: vi.fn(() => true),
    })),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('updates command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws without scope parameter', async () => {
        const { execute } = await import('../../src/commands/updates');
        await expect(execute(createConfig({ dryRun: true }))).rejects.toThrow('No scope specified and no default scopes configured');
    });

    it('executes with scope parameter', async () => {
        const { execute } = await import('../../src/commands/updates');
        const result = await execute(createConfig({
            dryRun: true,
            updates: { scope: '@myorg' }
        }));
        expect(result).toBeDefined();
    });

    it('handles tree.packageArgument as scope', async () => {
        const { execute } = await import('../../src/commands/updates');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { packageArgument: '@myorg' }
        }));
        expect(result).toBeDefined();
    });

    it('handles inter-project mode', async () => {
        const { execute } = await import('../../src/commands/updates');
        const result = await execute(createConfig({
            dryRun: true,
            updates: {
                scope: '@myorg',
                interProject: true
            }
        }));
        expect(result).toBeDefined();
    });

    it('throws on invalid scope', async () => {
        const { execute } = await import('../../src/commands/updates');
        await expect(execute(createConfig({
            dryRun: true,
            updates: { scope: 'invalid' }
        }))).rejects.toThrow('Invalid scope');
    });

    it('handles debug mode with scope', async () => {
        const { execute } = await import('../../src/commands/updates');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true,
            updates: { scope: '@myorg' }
        }));
        expect(result).toBeDefined();
    });
});
