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
    findAllPackageJsonFiles: vi.fn(() => []),
}));

vi.mock('@eldrforge/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0"}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
        exists: vi.fn(() => true),
    })),
}));

vi.mock('fs/promises', () => ({
    default: {
        lstat: vi.fn(() => ({ isSymbolicLink: () => false })),
        readlink: vi.fn(() => '../other'),
        rm: vi.fn(),
        unlink: vi.fn(),
    }
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('unlink command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
    });

    it('handles package argument', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({ dryRun: true }), '@test/pkg');
        expect(result).toBeDefined();
    });

    it('handles scope-only argument', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({ dryRun: true }), '@myorg');
        expect(result).toBeDefined();
    });

    it('handles cleanNodeModules flag', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({
            dryRun: true,
            unlink: { cleanNodeModules: true }
        }));
        expect(result).toBeDefined();
    });

    it('handles custom directories', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { directories: [process.cwd()] }
        }));
        expect(result).toBeDefined();
    });

    it('handles unlink.packageArgument from config', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({
            dryRun: true,
            unlink: { packageArgument: '@test/specific' }
        }));
        expect(result).toBeDefined();
    });

    it('handles debug mode', async () => {
        const { execute } = await import('../../src/commands/unlink');
        const result = await execute(createConfig({
            dryRun: true,
            debug: true
        }));
        expect(result).toBeDefined();
    });
});
