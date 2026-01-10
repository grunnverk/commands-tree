import { getLogger } from '@eldrforge/core';
import { run } from '@eldrforge/git-tools';
import { PerformanceTimer } from '@eldrforge/commands-git';

// Check if npm install is needed by examining lock file and node_modules
export const isNpmInstallNeeded = async (storage: any): Promise<{ needed: boolean; reason: string }> => {
    const logger = getLogger();
    const timer = PerformanceTimer.start(logger, 'Checking if npm install is needed');

    try {
        // Check if package-lock.json exists
        const hasLockFile = await storage.exists('package-lock.json');
        if (!hasLockFile) {
            timer.end('npm install needed - no lock file');
            return { needed: true, reason: 'No package-lock.json found' };
        }

        // Check if node_modules exists
        const hasNodeModules = await storage.exists('node_modules');
        if (!hasNodeModules) {
            timer.end('npm install needed - no node_modules');
            return { needed: true, reason: 'No node_modules directory found' };
        }

        // Check if node_modules is populated (has at least a few entries)
        const nodeModulesContents = await storage.listFiles('node_modules');
        if (nodeModulesContents.length < 3) { // Usually has .bin, .package-lock.json, and packages
            timer.end('npm install needed - empty node_modules');
            return { needed: true, reason: 'node_modules appears empty or incomplete' };
        }

        // Get timestamps to check if package.json is newer than node_modules
        const packageJsonStats = await storage.exists('package.json');
        if (!packageJsonStats) {
            timer.end('npm install not needed - no package.json');
            return { needed: false, reason: 'No package.json found' };
        }

        timer.end('npm install not needed - appears up to date');
        return { needed: false, reason: 'Dependencies appear to be up to date' };
    } catch (error: any) {
        timer.end(`npm install check failed: ${error.message}`);
        logger.debug(`Failed to check npm install status: ${error.message}`);
        return { needed: true, reason: 'Could not verify dependency status, installing to be safe' };
    }
};

// Run npm install with optimizations
export const optimizedNpmInstall = async (options: {
    skipIfNotNeeded?: boolean;
    useCache?: boolean;
    verbose?: boolean;
} = {}): Promise<{ duration: number; skipped: boolean; reason: string }> => {
    const logger = getLogger();
    const { createStorage } = await import('@eldrforge/shared');
    const storage = createStorage();

    const {
        skipIfNotNeeded = true,
        useCache = true,
        verbose = false
    } = options;

    // Check if install is needed
    if (skipIfNotNeeded) {
        const installCheck = await isNpmInstallNeeded(storage);
        if (!installCheck.needed) {
            logger.info(`NPM_INSTALL_SKIPPED: Skipping npm install optimization | Reason: ${installCheck.reason} | Status: not-needed`);
            return { duration: 0, skipped: true, reason: installCheck.reason };
        } else {
            logger.verbose(`📦 npm install required: ${installCheck.reason}`);
        }
    }

    // Build optimized npm install command
    const npmArgs = ['install'];

    if (!verbose) {
        npmArgs.push('--silent');
    }

    if (useCache) {
        // npm uses cache by default, but we can ensure it's not bypassed
        npmArgs.push('--prefer-offline');
    }

    // Use --no-audit and --no-fund for faster installs in link/unlink scenarios
    npmArgs.push('--no-audit', '--no-fund');

    const command = `npm ${npmArgs.join(' ')}`;

    logger.info(`NPM_INSTALL_OPTIMIZED: Running optimized npm install | Mode: optimized | Command: npm install`);
    logger.verbose(`Command: ${command}`);

    const timer = PerformanceTimer.start(logger, 'Optimized npm install execution');

    try {
        await run(command);
        const duration = timer.end('Optimized npm install completed successfully');
        logger.info(`NPM_INSTALL_SUCCESS: Dependencies installed successfully | Duration: ${duration}ms | Status: completed`);
        return { duration, skipped: false, reason: 'Installation completed successfully' };
    } catch (error: any) {
        timer.end('Optimized npm install failed');
        throw new Error(`Failed to run optimized npm install: ${error.message}`);
    }
};

// Helper to run npm ci if package-lock.json is available (faster than npm install)
export const tryNpmCi = async (): Promise<{ success: boolean; duration?: number }> => {
    const logger = getLogger();
    const { createStorage } = await import('@eldrforge/shared');
    const storage = createStorage();

    try {
        // Check if package-lock.json exists
        const hasLockFile = await storage.exists('package-lock.json');
        if (!hasLockFile) {
            return { success: false };
        }

        logger.info('NPM_CI_USING: Using npm ci for faster installation | Command: npm ci | Advantage: Faster clean install');
        const timer = PerformanceTimer.start(logger, 'npm ci execution');

        await run('npm ci --silent --no-audit --no-fund');
        const duration = timer.end('npm ci completed successfully');

        logger.info(`NPM_CI_SUCCESS: Dependencies installed with npm ci | Duration: ${duration}ms | Status: completed`);
        return { success: true, duration };
    } catch (error: any) {
        logger.verbose(`npm ci failed, will fall back to npm install: ${error.message}`);
        return { success: false };
    }
};

// Main function that tries the fastest approach first
export const smartNpmInstall = async (options: {
    skipIfNotNeeded?: boolean;
    preferCi?: boolean;
    verbose?: boolean;
} = {}): Promise<{ duration: number; method: string; skipped: boolean }> => {
    const logger = getLogger();
    const {
        skipIfNotNeeded = true,
        preferCi = true,
        verbose = false
    } = options;

    const overallTimer = PerformanceTimer.start(logger, 'Smart npm install');

    // Try npm ci first if preferred and available
    if (preferCi) {
        const ciResult = await tryNpmCi();
        if (ciResult.success) {
            overallTimer.end('Smart npm install completed with npm ci');
            return {
                duration: ciResult.duration || 0,
                method: 'npm ci',
                skipped: false
            };
        }
    }

    // Fall back to optimized npm install
    const installResult = await optimizedNpmInstall({
        skipIfNotNeeded,
        useCache: true,
        verbose
    });

    overallTimer.end(`Smart npm install completed with ${installResult.skipped ? 'skip' : 'npm install'}`);

    return {
        duration: installResult.duration,
        method: installResult.skipped ? 'skipped' : 'npm install',
        skipped: installResult.skipped
    };
};
