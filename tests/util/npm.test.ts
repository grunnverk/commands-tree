import { describe, it, expect, vi } from 'vitest';
import { isNpmInstallNeeded } from '../../src/util/npmOptimizations';

const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

vi.mock('@eldrforge/core', () => ({ getLogger: () => mockLogger }));
vi.mock('@eldrforge/git-tools', () => ({ run: vi.fn().mockResolvedValue({ stdout: '' }) }));
vi.mock('@eldrforge/commands-git', () => ({ PerformanceTimer: { start: () => ({ end: vi.fn() }) } }));

describe('npm optimizations', () => {
    it('checks if install needed', async () => {
        const storage = {
            exists: vi.fn().mockResolvedValue(true),
            listFiles: vi.fn().mockResolvedValue(['a', 'b', 'c', 'd'])
        };
        const result = await isNpmInstallNeeded(storage);
        expect(result).toHaveProperty('needed');
        expect(result).toHaveProperty('reason');
    });

    it('detects missing lock file', async () => {
        const storage = { exists: vi.fn().mockResolvedValue(false), listFiles: vi.fn() };
        const result = await isNpmInstallNeeded(storage);
        expect(result.needed).toBe(true);
    });

    it('detects missing node_modules', async () => {
        const storage = {
            exists: vi.fn().mockImplementation((path: string) => path === 'package-lock.json'),
            listFiles: vi.fn()
        };
        const result = await isNpmInstallNeeded(storage);
        expect(result.needed).toBe(true);
    });

    it('detects empty node_modules', async () => {
        const storage = {
            exists: vi.fn().mockResolvedValue(true),
            listFiles: vi.fn().mockResolvedValue(['a', 'b'])
        };
        const result = await isNpmInstallNeeded(storage);
        expect(result.needed).toBe(true);
    });

    it('passes when all present', async () => {
        const storage = {
            exists: vi.fn().mockResolvedValue(true),
            listFiles: vi.fn().mockResolvedValue(['a', 'b', 'c', 'd', 'e'])
        };
        const result = await isNpmInstallNeeded(storage);
        expect(result.needed).toBe(false);
    });
});

