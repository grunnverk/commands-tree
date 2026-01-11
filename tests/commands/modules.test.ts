import { describe, it, expect } from 'vitest';

describe('tree modules', () => {
    it('loads link module', async () => {
        const module = await import('../../src/commands/link');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads unlink module', async () => {
        const module = await import('../../src/commands/unlink');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads tree module', async () => {
        const module = await import('../../src/commands/tree');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads updates module', async () => {
        const module = await import('../../src/commands/updates');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('loads versions module', async () => {
        const module = await import('../../src/commands/versions');
        expect(module).toBeDefined();
        expect(module.execute).toBeDefined();
    });

    it('index exports all commands', async () => {
        const module = await import('../../src/index');
        expect(module.link).toBeDefined();
        expect(module.unlink).toBeDefined();
        expect(module.tree).toBeDefined();
        expect(module.updates).toBeDefined();
        expect(module.versions).toBeDefined();
    });
});

