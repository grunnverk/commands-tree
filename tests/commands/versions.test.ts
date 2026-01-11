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
        { path: `${process.cwd()}/package.json` }
    ]),
    batchReadPackageJsonFiles: vi.fn(() => [
        { path: `${process.cwd()}/package.json`, content: { name: '@test/pkg', version: '1.0.0' } }
    ]),
}));

vi.mock('@eldrforge/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('versions command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws without subcommand', async () => {
        const { execute } = await import('../../src/commands/versions');
        await expect(execute(createConfig({ dryRun: true }))).rejects.toThrow('Versions command requires a subcommand');
    });

    it('executes with minor subcommand', async () => {
        const { execute } = await import('../../src/commands/versions');
        const result = await execute(createConfig({
            dryRun: true,
            versions: { subcommand: 'minor' }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode with minor', async () => {
        const { execute } = await import('../../src/commands/versions');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true,
            versions: { subcommand: 'minor' }
        }));
        expect(result).toBeDefined();
    });

    it('throws on unknown subcommand', async () => {
        const { execute } = await import('../../src/commands/versions');
        await expect(execute(createConfig({
            dryRun: true,
            versions: { subcommand: 'unknown' as any }
        }))).rejects.toThrow('Unknown versions subcommand');
    });
});
