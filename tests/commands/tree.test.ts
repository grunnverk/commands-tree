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
    run: vi.fn(() => ({ stdout: '' })),
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
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0", "dependencies": {}}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('tree command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
    });

    it('handles current directory', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { directories: [process.cwd()] }
        }));
        expect(result).toBeDefined();
    });

    it('handles exclude patterns', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { exclude: ['node_modules', 'dist'] }
        }));
        expect(result).toBeDefined();
    });

    it('handles status flag', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { status: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles parallel option', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { parallel: true, maxConcurrency: 4 }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/tree');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });
});
