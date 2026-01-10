import { describe, it, expect } from 'vitest';
import * as commands from '../src/index';

describe('commands-tree exports', () => {
    it('should export tree command', () => {
        expect(commands.tree).toBeDefined();
        expect(typeof commands.tree).toBe('function');
    });

    it('should export link', () => {
        expect(commands.link).toBeDefined();
        expect(typeof commands.link).toBe('function');
    });

    it('should export unlink', () => {
        expect(commands.unlink).toBeDefined();
        expect(typeof commands.unlink).toBe('function');
    });

    it('should export versions', () => {
        expect(commands.versions).toBeDefined();
        expect(typeof commands.versions).toBe('function');
    });

    it('should export updates', () => {
        expect(commands.updates).toBeDefined();
        expect(typeof commands.updates).toBe('function');
    });
});
