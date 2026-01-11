import { describe, it, expect } from 'vitest';

describe('commands-tree smoke', () => {
    it('loads link', async () => { const m = await import('../src/commands/link'); expect(m.execute).toBeDefined(); });
    it('loads unlink', async () => { const m = await import('../src/commands/unlink'); expect(m.execute).toBeDefined(); });
    it('loads tree', async () => { const m = await import('../src/commands/tree'); expect(m.execute).toBeDefined(); });
    it('loads updates', async () => { const m = await import('../src/commands/updates'); expect(m.execute).toBeDefined(); });
    it('loads versions', async () => { const m = await import('../src/commands/versions'); expect(m.execute).toBeDefined(); });
    it('loads npm opts', async () => { const m = await import('../src/util/npmOptimizations'); expect(m.isNpmInstallNeeded).toBeDefined(); });
    it('loads tracker', async () => { const m = await import('../src/util/performanceTracker'); expect(m.PerformanceTracker).toBeDefined(); });
    it('loads branch state', async () => { const m = await import('../src/utils/branchState'); expect(m).toBeDefined(); });
    it('link export', async () => { const m = await import('../src/index'); expect(typeof m.link).toBe('function'); });
    it('unlink export', async () => { const m = await import('../src/index'); expect(typeof m.unlink).toBe('function'); });
    it('tree export', async () => { const m = await import('../src/index'); expect(typeof m.tree).toBe('function'); });
    it('updates export', async () => { const m = await import('../src/index'); expect(typeof m.updates).toBe('function'); });
    it('versions export', async () => { const m = await import('../src/index'); expect(typeof m.versions).toBe('function'); });
    it('npm export', async () => { const m = await import('../src/index'); expect(m.isNpmInstallNeeded).toBeDefined(); });
    it('tracker export', async () => { const m = await import('../src/index'); expect(m.PerformanceTracker).toBeDefined(); });
});

