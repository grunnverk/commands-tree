import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@grunnverk/core';

// Mock dependencies
vi.mock('@grunnverk/core', () => ({
    getLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    getDryRunLogger: vi.fn(() => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn()
    })),
    Config: {},
}));

vi.mock('@grunnverk/git-tools', () => ({
    run: vi.fn(() => ({ stdout: '' })),
    runSecure: vi.fn(() => ({ stdout: '' })),
    safeJsonParse: vi.fn((s) => JSON.parse(s)),
    validatePackageJson: vi.fn((p) => p),
}));

vi.mock('@grunnverk/commands-git', () => ({
    findAllPackageJsonFiles: vi.fn(() => []),
}));

vi.mock('@grunnverk/shared', () => ({
    createStorage: vi.fn(() => ({
        readFile: vi.fn(() => '{"name": "@test/pkg", "version": "1.0.0", "dependencies": {}, "devDependencies": {}}'),
        writeFile: vi.fn(),
        ensureDirectory: vi.fn(),
    })),
}));

vi.mock('fs/promises', () => ({
    default: {
        lstat: vi.fn(() => ({ isSymbolicLink: () => false })),
        readlink: vi.fn(() => '../other'),
        mkdir: vi.fn(),
        symlink: vi.fn(),
        unlink: vi.fn(),
        rm: vi.fn(),
    }
}));

// Helper to create valid Config
const createConfig = (overrides: Partial<Config> = {}): Config => ({
    configDirectory: '.kodrdriv',
    ...overrides
} as Config);

describe('link command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('executes with basic config', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({ dryRun: true }));
        expect(result).toBeDefined();
        expect(typeof result).toBe('string');
    });

    it('handles status subcommand', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({ dryRun: true }), 'status');
        expect(result).toBeDefined();
    });

    it('handles custom target directories', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({
            dryRun: true,
            tree: { directories: [process.cwd()] }
        }));
        expect(result).toBeDefined();
    });

    it('handles external link patterns', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({
            dryRun: true,
            link: { externals: ['@external/pkg'] }
        }));
        expect(result).toBeDefined();
    });

    it('handles scopeRoots configuration', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({
            dryRun: true,
            link: {
                scopeRoots: { '@other': '../other-workspace' }
            }
        }));
        expect(result).toBeDefined();
    });

    it('handles dry run mode', async () => {
        const { execute } = await import('../../src/commands/link');
        const result = await execute(createConfig({
            link: { dryRun: true }
        }));
        expect(result).toBeDefined();
    });
});
