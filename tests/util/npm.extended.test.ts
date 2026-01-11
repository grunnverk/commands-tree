import { describe, it, expect, vi } from 'vitest';
import { tryNpmCi, isNpmInstallNeeded } from '../../src/util/npmOptimizations';

const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn(), error: vi.fn() };

vi.mock('@eldrforge/core', () => ({ getLogger: () => mockLogger }));
vi.mock('@eldrforge/git-tools', () => ({ run: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }) }));
vi.mock('@eldrforge/commands-git', () => ({ PerformanceTimer: { start: () => ({ end: vi.fn() }) } }));

describe('npm optimizations extended', () => {
    it('tries npm ci', async () => {
        const result = await tryNpmCi();
        expect(result).toHaveProperty('success');
    });

    it('checks if install needed', async () => {
        const storage = { exists: vi.fn().mockResolvedValue(true), listFiles: vi.fn().mockResolvedValue(['a','b','c']) };
        const result = await isNpmInstallNeeded(storage);
        expect(result).toHaveProperty('needed');
        expect(result).toHaveProperty('reason');
    });
});
