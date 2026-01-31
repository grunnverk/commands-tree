import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PackageContextFactory } from '@grunnverk/tree-execution';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Test that verifies context isolation in parallel execution scenarios
 */
describe('Parallel Context Isolation', () => {
    let testDir1: string;
    let testDir2: string;
    let testDir3: string;
    
    beforeEach(() => {
        testDir1 = mkdtempSync(join(tmpdir(), 'kodrdriv-parallel-1-'));
        testDir2 = mkdtempSync(join(tmpdir(), 'kodrdriv-parallel-2-'));
        testDir3 = mkdtempSync(join(tmpdir(), 'kodrdriv-parallel-3-'));
    });
    
    afterEach(() => {
        rmSync(testDir1, { recursive: true, force: true });
        rmSync(testDir2, { recursive: true, force: true });
        rmSync(testDir3, { recursive: true, force: true });
    });
    
    describe('context isolation', () => {
        it('should create isolated contexts for multiple packages with different repositories', () => {
            // Setup: Create three git repos with different remotes
            execSync('git init', { cwd: testDir1 });
            execSync('git remote add origin git@github.com:org1/repo1.git', { cwd: testDir1 });
            
            execSync('git init', { cwd: testDir2 });
            execSync('git remote add origin git@github.com:org2/repo2.git', { cwd: testDir2 });
            
            execSync('git init', { cwd: testDir3 });
            execSync('git remote add origin git@github.com:org3/repo3.git', { cwd: testDir3 });
            
            // Execute: Create contexts (simulating parallel execution)
            const contexts = PackageContextFactory.createContexts([
                { name: '@test/package1', path: testDir1 },
                { name: '@test/package2', path: testDir2 },
                { name: '@test/package3', path: testDir3 },
            ]);
            
            // Assert: Each context has correct repository information
            expect(contexts.size).toBe(3);
            
            const ctx1 = contexts.get('@test/package1');
            expect(ctx1).toBeDefined();
            expect(ctx1!.repositoryOwner).toBe('org1');
            expect(ctx1!.repositoryName).toBe('repo1');
            expect(ctx1!.repositoryUrl).toBe('https://github.com/org1/repo1');
            
            const ctx2 = contexts.get('@test/package2');
            expect(ctx2).toBeDefined();
            expect(ctx2!.repositoryOwner).toBe('org2');
            expect(ctx2!.repositoryName).toBe('repo2');
            expect(ctx2!.repositoryUrl).toBe('https://github.com/org2/repo2');
            
            const ctx3 = contexts.get('@test/package3');
            expect(ctx3).toBeDefined();
            expect(ctx3!.repositoryOwner).toBe('org3');
            expect(ctx3!.repositoryName).toBe('repo3');
            expect(ctx3!.repositoryUrl).toBe('https://github.com/org3/repo3');
        });
        
        it('should maintain isolation even when process.cwd() changes', () => {
            // Setup: Create two repos
            execSync('git init', { cwd: testDir1 });
            execSync('git remote add origin git@github.com:org1/repo1.git', { cwd: testDir1 });
            
            execSync('git init', { cwd: testDir2 });
            execSync('git remote add origin git@github.com:org2/repo2.git', { cwd: testDir2 });
            
            // Create contexts
            const contexts = PackageContextFactory.createContexts([
                { name: '@test/package1', path: testDir1 },
                { name: '@test/package2', path: testDir2 },
            ]);
            
            // Simulate parallel execution: change working directory multiple times
            const originalCwd = process.cwd();
            
            // Change to testDir1
            process.chdir(testDir1);
            const ctx1 = contexts.get('@test/package1')!;
            expect(ctx1.repositoryOwner).toBe('org1');
            expect(ctx1.repositoryName).toBe('repo1');
            
            // Change to testDir2
            process.chdir(testDir2);
            // Context 1 should still have repo1 info (not affected by cwd change)
            expect(ctx1.repositoryOwner).toBe('org1');
            expect(ctx1.repositoryName).toBe('repo1');
            
            // Context 2 should have repo2 info
            const ctx2 = contexts.get('@test/package2')!;
            expect(ctx2.repositoryOwner).toBe('org2');
            expect(ctx2.repositoryName).toBe('repo2');
            
            // Change to original directory
            process.chdir(originalCwd);
            // Both contexts should still have correct info
            expect(ctx1.repositoryOwner).toBe('org1');
            expect(ctx2.repositoryOwner).toBe('org2');
        });
        
        it('should detect repository information at context creation time, not access time', () => {
            // Setup
            execSync('git init', { cwd: testDir1 });
            execSync('git remote add origin git@github.com:org1/repo1.git', { cwd: testDir1 });
            
            execSync('git init', { cwd: testDir2 });
            execSync('git remote add origin git@github.com:org2/repo2.git', { cwd: testDir2 });
            
            // Create context for package1 while in testDir1
            process.chdir(testDir1);
            const ctx1 = PackageContextFactory.createContext({
                name: '@test/package1',
                path: testDir1,
            });
            
            // Create context for package2 while in testDir2
            process.chdir(testDir2);
            const ctx2 = PackageContextFactory.createContext({
                name: '@test/package2',
                path: testDir2,
            });
            
            // Change to a completely different directory
            process.chdir(tmpdir());
            
            // Both contexts should still have correct repository info
            // (not affected by current working directory)
            expect(ctx1.repositoryOwner).toBe('org1');
            expect(ctx1.repositoryName).toBe('repo1');
            expect(ctx2.repositoryOwner).toBe('org2');
            expect(ctx2.repositoryName).toBe('repo2');
        });
    });
    
    describe('context validation', () => {
        it('should validate all contexts successfully', () => {
            // Setup
            execSync('git init', { cwd: testDir1 });
            execSync('git remote add origin git@github.com:org1/repo1.git', { cwd: testDir1 });
            
            execSync('git init', { cwd: testDir2 });
            execSync('git remote add origin git@github.com:org2/repo2.git', { cwd: testDir2 });
            
            // Create contexts
            const contexts = PackageContextFactory.createContexts([
                { name: '@test/package1', path: testDir1 },
                { name: '@test/package2', path: testDir2 },
            ]);
            
            // All contexts should validate successfully
            contexts.forEach((ctx, name) => {
                expect(() => ctx.validate()).not.toThrow();
            });
        });
    });
    
    describe('real-world scenario simulation', () => {
        it('should handle the bug scenario: multiple packages in parallel', () => {
            // This simulates the actual bug we're fixing:
            // - Package 1 is @kjerneverk/agentic in kjerneverk/agentic
            // - Package 2 is @kjerneverk/execution in kjerneverk/execution-openai
            // - Bug: Both packages tried to use execution-openai repository
            
            // Setup: Create repos simulating the real scenario
            execSync('git init', { cwd: testDir1 });
            execSync('git remote add origin git@github.com:kjerneverk/agentic.git', { cwd: testDir1 });
            
            execSync('git init', { cwd: testDir2 });
            execSync('git remote add origin git@github.com:kjerneverk/execution-openai.git', { cwd: testDir2 });
            
            // Create contexts (this happens before parallel execution)
            const contexts = PackageContextFactory.createContexts([
                { name: '@kjerneverk/agentic', path: testDir1 },
                { name: '@kjerneverk/execution', path: testDir2 },
            ]);
            
            // Verify: Each package has its own repository
            const agenticCtx = contexts.get('@kjerneverk/agentic')!;
            expect(agenticCtx.repositoryName).toBe('agentic');
            expect(agenticCtx.repositoryOwner).toBe('kjerneverk');
            
            const executionCtx = contexts.get('@kjerneverk/execution')!;
            expect(executionCtx.repositoryName).toBe('execution-openai');
            expect(executionCtx.repositoryOwner).toBe('kjerneverk');
            
            // The fix: Each context maintains its own repository info
            // even if process.cwd() changes during parallel execution
            process.chdir(testDir2);
            expect(agenticCtx.repositoryName).toBe('agentic'); // Still correct!
            expect(executionCtx.repositoryName).toBe('execution-openai'); // Still correct!
        });
    });
});
