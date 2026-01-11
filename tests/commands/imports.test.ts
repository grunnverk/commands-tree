import { describe, it, expect } from 'vitest';

describe('command imports and basic validation', () => {
    it('should import link command', async () => {
        const module = await import('../../src/index');
        expect(module.link).toBeDefined();
        expect(typeof module.link).toBe('function');
    });

    it('should import unlink command', async () => {
        const module = await import('../../src/index');
        expect(module.unlink).toBeDefined();
        expect(typeof module.unlink).toBe('function');
    });

    it('should import tree command', async () => {
        const module = await import('../../src/index');
        expect(module.tree).toBeDefined();
        expect(typeof module.tree).toBe('function');
    });

    it('should import updates command', async () => {
        const module = await import('../../src/index');
        expect(module.updates).toBeDefined();
        expect(typeof module.updates).toBe('function');
    });

    it('should import versions command', async () => {
        const module = await import('../../src/index');
        expect(module.versions).toBeDefined();
        expect(typeof module.versions).toBe('function');
    });

    it('should import utility functions', async () => {
        const module = await import('../../src/index');
        // Check for actual exported utility functions
        expect(Object.keys(module).length).toBeGreaterThan(5);
    });
});

