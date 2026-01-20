#!/usr/bin/env node
/**
 * Tree command - Central dependency analysis and tree traversal for kodrdriv
 *
 * This command supports two execution modes:
 * 1. Custom command mode: `kodrdriv tree --cmd "npm install"`
 * 2. Built-in command mode: `kodrdriv tree commit`, `kodrdriv tree publish`, etc.
 *
 * Built-in commands shell out to separate kodrdriv processes to preserve
 * individual project configurations while leveraging centralized dependency analysis.
 *
 * Supported built-in commands: commit, release, publish, link, unlink, development, branches, checkout, precommit
 *
 * Enhanced logging based on debug/verbose flags:
 *
 * --debug:
 *   - Shows all command output (stdout/stderr)
 *   - Shows detailed debug messages about dependency levels and execution flow
 *   - Shows package-by-package dependency analysis
 *   - Shows detailed level start/completion information
 *
 * --verbose:
 *   - Shows exactly what's happening without full command output
 *   - Shows level-by-level execution progress
 *   - Shows package grouping information
 *   - Shows basic execution flow
 *
 * No flags:
 *   - For commit and publish commands: Shows full output from child processes by default
 *     (including AI generation, self-reflection, and agentic interactions)
 *   - For other commands: Shows basic progress with numeric representation ([1/5] Package: Running...)
 *   - Shows level-by-level execution summaries
 *   - Shows completion status for each package and level
 */
import path from 'path';
import fs from 'fs/promises';
import child_process, { exec } from 'child_process';
import { run, runSecure, safeJsonParse, validatePackageJson, getGitStatusSummary, getGloballyLinkedPackages, getLinkedDependencies, getLinkCompatibilityProblems } from '@eldrforge/git-tools';
import util from 'util';
import { getLogger, Config, getOutputPath, DEFAULT_OUTPUT_DIRECTORY, runGitWithLock, isInGitRepository } from '@eldrforge/core';
import { createStorage } from '@eldrforge/shared';
import * as Commit from '@eldrforge/commands-git';
import * as Link from './link';
import * as Unlink from './unlink';
import * as Updates from './updates';
import type {
    PackageInfo,
    DependencyGraph
} from '@eldrforge/tree-core';
import {
    scanForPackageJsonFiles,
    parsePackageJson,
    buildDependencyGraph,
    topologicalSort,
    shouldExclude
} from '@eldrforge/tree-core';
import { optimizePrecommitCommand, recordTestRun, PerformanceTimer } from '@eldrforge/commands-git';

// Track published versions during tree publish
interface PublishedVersion {
    packageName: string;
    version: string;
    publishTime: Date;
}

// Tree execution context for persistence
interface TreeExecutionContext {
    command: string;
    originalConfig: Config;
    publishedVersions: PublishedVersion[];
    completedPackages: string[];
    buildOrder: string[];
    startTime: Date;
    lastUpdateTime: Date;
}

// Global state to track published versions during tree execution - protected by mutex
let publishedVersions: PublishedVersion[] = [];
let executionContext: TreeExecutionContext | null = null;

// Function to reset global state (for testing)
export const __resetGlobalState = () => {
    publishedVersions = [];
    executionContext = null;
};

// Import shared mutex implementation from tree-execution
import { SimpleMutex } from '@eldrforge/tree-execution';

const globalStateMutex = new SimpleMutex();

// Update inter-project dependencies in package.json based on published versions
const updateInterProjectDependencies = async (
    packageDir: string,
    publishedVersions: PublishedVersion[],
    allPackageNames: Set<string>,
    packageLogger: any,
    isDryRun: boolean
): Promise<boolean> => {
    const storage = createStorage();
    const packageJsonPath = path.join(packageDir, 'package.json');

    if (!await storage.exists(packageJsonPath)) {
        packageLogger.verbose('No package.json found, skipping dependency updates');
        return false;
    }

    let hasChanges = false;

    try {
        const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
        const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
        const packageJson = validatePackageJson(parsed, packageJsonPath);

        const sectionsToUpdate = ['dependencies', 'devDependencies', 'peerDependencies'];

        for (const publishedVersion of publishedVersions) {
            const { packageName, version } = publishedVersion;

            // Only update if this is an inter-project dependency (exists in our build tree)
            if (!allPackageNames.has(packageName)) {
                continue;
            }

            // Skip prerelease versions (e.g., 1.0.0-beta.1, 2.0.0-alpha.3)
            // Prerelease versions should not be automatically propagated to consumers
            if (version.includes('-')) {
                packageLogger.verbose(`Skipping prerelease version ${packageName}@${version} - not updating dependencies`);
                continue;
            }

            // Update the dependency in all relevant sections
            for (const section of sectionsToUpdate) {
                const deps = packageJson[section];
                if (deps && deps[packageName]) {
                    const oldVersion = deps[packageName];
                    const newVersion = `^${version}`;

                    if (oldVersion !== newVersion) {
                        if (isDryRun) {
                            packageLogger.info(`Would update ${section}.${packageName}: ${oldVersion} → ${newVersion}`);
                        } else {
                            packageLogger.info(`Updating ${section}.${packageName}: ${oldVersion} → ${newVersion}`);
                            deps[packageName] = newVersion;
                        }
                        hasChanges = true;
                    }
                }
            }
        }

        if (hasChanges && !isDryRun) {
            // Write updated package.json
            await storage.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
            packageLogger.info('Inter-project dependencies updated successfully');
        }

    } catch (error: any) {
        packageLogger.warn(`Failed to update inter-project dependencies: ${error.message}`);
        return false;
    }

    return hasChanges;
};

// Detect scoped dependencies from package.json and run updates for them
const updateScopedDependencies = async (
    packageDir: string,
    packageLogger: any,
    isDryRun: boolean,
    runConfig: Config
): Promise<boolean> => {
    const storage = createStorage();
    const packageJsonPath = path.join(packageDir, 'package.json');

    if (!await storage.exists(packageJsonPath)) {
        packageLogger.verbose('No package.json found, skipping scoped dependency updates');
        return false;
    }

    try {
        // Read the package.json before updates
        const beforeContent = await storage.readFile(packageJsonPath, 'utf-8');
        const parsed = safeJsonParse(beforeContent, packageJsonPath);
        const packageJson = validatePackageJson(parsed, packageJsonPath);

        // Determine which scopes to update
        let scopesToUpdate: Set<string>;

        // Check if scopedDependencyUpdates is configured
        const configuredScopes = runConfig.publish?.scopedDependencyUpdates;

        if (configuredScopes !== undefined) {
            // scopedDependencyUpdates is explicitly configured
            if (configuredScopes.length > 0) {
                // Use configured scopes
                scopesToUpdate = new Set(configuredScopes);
                packageLogger.verbose(`Using configured scopes: ${Array.from(scopesToUpdate).join(', ')}`);
            } else {
                // Empty array means explicitly disabled
                packageLogger.verbose('Scoped dependency updates explicitly disabled');
                return false;
            }
        } else {
            // Not configured - use default behavior (package's own scope)
            scopesToUpdate = new Set<string>();

            if (packageJson.name && packageJson.name.startsWith('@')) {
                const packageScope = packageJson.name.split('/')[0]; // e.g., "@fjell/core" -> "@fjell"
                scopesToUpdate.add(packageScope);
                packageLogger.verbose(`No scopes configured, defaulting to package's own scope: ${packageScope}`);
            } else {
                packageLogger.verbose('Package is not scoped and no scopes configured, skipping scoped dependency updates');
                return false;
            }
        }

        if (scopesToUpdate.size === 0) {
            packageLogger.verbose('No scopes to update, skipping updates');
            return false;
        }

        // Run updates for each scope
        for (const scope of scopesToUpdate) {
            packageLogger.info(`🔄 Checking for ${scope} dependency updates before publish...`);

            try {
                // Create a config for the updates command with the scope
                const updatesConfig: Config = {
                    ...runConfig,
                    dryRun: isDryRun,
                    updates: {
                        scope: scope
                    }
                };

                await Updates.execute(updatesConfig);
            } catch (error: any) {
                // Don't fail the publish if updates fails, just warn
                packageLogger.warn(`Failed to update ${scope} dependencies: ${error.message}`);
            }
        }

        // Check if package.json was modified
        const afterContent = await storage.readFile(packageJsonPath, 'utf-8');
        const hasChanges = beforeContent !== afterContent;

        if (hasChanges) {
            packageLogger.info('✅ Scoped dependencies updated successfully');
        } else {
            packageLogger.info('No scoped dependency updates needed');
        }

        return hasChanges;
    } catch (error: any) {
        packageLogger.warn(`Failed to detect scoped dependencies: ${error.message}`);
        return false;
    }
};

// Get the context file path
const getContextFilePath = (outputDirectory?: string): string => {
    const outputDir = outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
    return getOutputPath(outputDir, '.kodrdriv-context');
};

// Save execution context to file
const saveExecutionContext = async (context: TreeExecutionContext, outputDirectory?: string): Promise<void> => {
    const storage = createStorage(); // Silent storage for context operations
    const contextFilePath = getContextFilePath(outputDirectory);

    try {
        // Ensure output directory exists
        await storage.ensureDirectory(path.dirname(contextFilePath));

        // Save context with JSON serialization that handles dates
        const contextData = {
            ...context,
            startTime: context.startTime.toISOString(),
            lastUpdateTime: context.lastUpdateTime.toISOString(),
            publishedVersions: context.publishedVersions.map(v => ({
                ...v,
                publishTime: v.publishTime.toISOString()
            }))
        };

        await storage.writeFile(contextFilePath, JSON.stringify(contextData, null, 2), 'utf-8');
    } catch (error: any) {
        // Don't fail the entire operation if context saving fails
        const logger = getLogger();
        logger.warn(`Warning: Failed to save execution context: ${error.message}`);
    }
};

// Load execution context from file
const loadExecutionContext = async (outputDirectory?: string): Promise<TreeExecutionContext | null> => {
    const storage = createStorage(); // Silent storage for context operations
    const contextFilePath = getContextFilePath(outputDirectory);

    try {
        if (!await storage.exists(contextFilePath)) {
            return null;
        }

        const contextContent = await storage.readFile(contextFilePath, 'utf-8');
        const contextData = safeJsonParse(contextContent, contextFilePath);

        // Restore dates from ISO strings
        return {
            ...contextData,
            startTime: new Date(contextData.startTime),
            lastUpdateTime: new Date(contextData.lastUpdateTime),
            publishedVersions: contextData.publishedVersions.map((v: any) => ({
                ...v,
                publishTime: new Date(v.publishTime)
            }))
        };
    } catch (error: any) {
        const logger = getLogger();
        logger.warn(`Warning: Failed to load execution context: ${error.message}`);
        return null;
    }
};

// Clean up context file
const cleanupContext = async (outputDirectory?: string): Promise<void> => {
    const storage = createStorage(); // Silent storage for context operations
    const contextFilePath = getContextFilePath(outputDirectory);

    try {
        if (await storage.exists(contextFilePath)) {
            await storage.deleteFile(contextFilePath);
        }
    } catch (error: any) {
        // Don't fail if cleanup fails
        const logger = getLogger();
        logger.warn(`Warning: Failed to cleanup execution context: ${error.message}`);
    }
};

// Helper function to promote a package to completed status in the context
const promotePackageToCompleted = async (
    packageName: string,
    outputDirectory?: string
): Promise<void> => {
    const storage = createStorage();
    const contextFilePath = getContextFilePath(outputDirectory);

    try {
        if (!await storage.exists(contextFilePath)) {
            return;
        }

        const contextContent = await storage.readFile(contextFilePath, 'utf-8');
        const contextData = safeJsonParse(contextContent, contextFilePath);

        // Restore dates from ISO strings
        const context: TreeExecutionContext = {
            ...contextData,
            startTime: new Date(contextData.startTime),
            lastUpdateTime: new Date(contextData.lastUpdateTime),
            publishedVersions: contextData.publishedVersions.map((v: any) => ({
                ...v,
                publishTime: new Date(v.publishTime)
            }))
        };

        // Add package to completed list if not already there
        if (!context.completedPackages.includes(packageName)) {
            context.completedPackages.push(packageName);
            context.lastUpdateTime = new Date();
            await saveExecutionContext(context, outputDirectory);
        }
    } catch (error: any) {
        const logger = getLogger();
        logger.warn(`Warning: Failed to promote package to completed: ${error.message}`);
    }
};

// Helper function to validate that all packages have the required scripts
const validateScripts = async (
    packages: Map<string, PackageInfo>,
    scripts: string[]
): Promise<{ valid: boolean; missingScripts: Map<string, string[]> }> => {
    const logger = getLogger();
    const missingScripts = new Map<string, string[]>();
    const storage = createStorage();

    logger.debug(`Validating scripts: ${scripts.join(', ')}`);

    for (const [packageName, packageInfo] of packages) {
        const packageJsonPath = path.join(packageInfo.path, 'package.json');
        const missingForPackage: string[] = [];

        try {
            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
            const packageJson = safeJsonParse(packageJsonContent, packageJsonPath);
            const validated = validatePackageJson(packageJson, packageJsonPath);

            // Check if each required script exists
            for (const script of scripts) {
                if (!validated.scripts || !validated.scripts[script]) {
                    missingForPackage.push(script);
                }
            }

            if (missingForPackage.length > 0) {
                missingScripts.set(packageName, missingForPackage);
                logger.debug(`Package ${packageName} missing scripts: ${missingForPackage.join(', ')}`);
            }
        } catch (error: any) {
            logger.debug(`Error reading package.json for ${packageName}: ${error.message}`);
            // If we can't read the package.json, assume all scripts are missing
            missingScripts.set(packageName, scripts);
        }
    }

    const valid = missingScripts.size === 0;

    if (valid) {
        logger.info(`✅ All packages have the required scripts: ${scripts.join(', ')}`);
    } else {
        logger.error(`❌ Script validation failed. Missing scripts:`);
        for (const [packageName, missing] of missingScripts) {
            logger.error(`  ${packageName}: ${missing.join(', ')}`);
        }
    }

    return { valid, missingScripts };
};

// Extract published version from git tags after successful publish
// After kodrdriv publish, the release version is captured in the git tag,
// while package.json contains the next dev version
const extractPublishedVersion = async (
    packageDir: string,
    packageLogger: any
): Promise<PublishedVersion | null> => {
    const storage = createStorage();
    const packageJsonPath = path.join(packageDir, 'package.json');

    try {
        // Get package name from package.json
        const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
        const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
        const packageJson = validatePackageJson(parsed, packageJsonPath);

        // Get the most recently created tag (by creation date, not version number)
        // This ensures we get the tag that was just created by the publish, not an older tag with a higher version
        const { stdout: tagOutput } = await run('git tag --sort=-creatordate', { cwd: packageDir });
        const tags = tagOutput.trim().split('\n').filter(Boolean);

        if (tags.length === 0) {
            packageLogger.warn('No git tags found after publish');
            return null;
        }

        // Get the most recently created tag (first in the list)
        const latestTag = tags[0];

        // Extract version from tag, handling various formats:
        // - v1.2.3 -> 1.2.3
        // - working/v1.2.3 -> 1.2.3
        // - main/v1.2.3 -> 1.2.3
        let version = latestTag;

        // If tag contains a slash (branch prefix), extract everything after it
        if (version.includes('/')) {
            version = version.split('/').pop() || version;
        }

        // Remove 'v' prefix if present
        if (version.startsWith('v')) {
            version = version.substring(1);
        }

        packageLogger.verbose(`Extracted published version from tag: ${latestTag} -> ${version}`);

        return {
            packageName: packageJson.name,
            version: version,
            publishTime: new Date()
        };
    } catch (error: any) {
        packageLogger.warn(`Failed to extract published version: ${error.message}`);
        return null;
    }
};

// Enhanced run function that can show output based on log level
const runWithLogging = async (
    command: string,
    packageLogger: any,
    options: child_process.ExecOptions = {},
    showOutput: 'none' | 'minimal' | 'full' = 'none',
    logFilePath?: string
): Promise<{ stdout: string; stderr: string }> => {
    const execPromise = util.promisify(exec);

    // Ensure encoding is set to 'utf8' to get string output instead of Buffer
    const execOptions = { encoding: 'utf8' as const, ...options };

    if (showOutput === 'full') {
        packageLogger.debug(`Executing command: ${command}`);
        // Use info level to show on console in debug mode
        packageLogger.info(`🔧 Running: ${command}`);
    } else if (showOutput === 'minimal') {
        packageLogger.verbose(`Running: ${command}`);
    }

    // Helper to write to log file
    const writeToLogFile = async (content: string) => {
        if (!logFilePath) return;
        try {
            const logDir = path.dirname(logFilePath);
            await fs.mkdir(logDir, { recursive: true });
            await fs.appendFile(logFilePath, content + '\n', 'utf-8');
        } catch (err: any) {
            packageLogger.warn(`Failed to write to log file ${logFilePath}: ${err.message}`);
        }
    };

    // Write command to log file
    if (logFilePath) {
        const timestamp = new Date().toISOString();
        await writeToLogFile(`[${timestamp}] Executing: ${command}\n`);
    }

    try {
        const result = await execPromise(command, execOptions);

        if (showOutput === 'full') {
            const stdout = String(result.stdout);
            const stderr = String(result.stderr);

            if (stdout.trim()) {
                packageLogger.debug('STDOUT:');
                packageLogger.debug(stdout);
                // Show on console using info level for immediate feedback
                packageLogger.info(`📤 STDOUT:`);
                stdout.split('\n').forEach((line: string) => {
                    if (line.trim()) packageLogger.info(`${line}`);
                });
            }
            if (stderr.trim()) {
                packageLogger.debug('STDERR:');
                packageLogger.debug(stderr);
                // Show on console using info level for immediate feedback
                packageLogger.info(`⚠️  STDERR:`);
                stderr.split('\n').forEach((line: string) => {
                    if (line.trim()) packageLogger.info(`${line}`);
                });
            }
        }

        // Write output to log file
        if (logFilePath) {
            const stdout = String(result.stdout);
            const stderr = String(result.stderr);
            if (stdout.trim()) {
                await writeToLogFile(`\n=== STDOUT ===\n${stdout}`);
            }
            if (stderr.trim()) {
                await writeToLogFile(`\n=== STDERR ===\n${stderr}`);
            }
            await writeToLogFile(`\n[${new Date().toISOString()}] Command completed successfully\n`);
        }

        // Ensure result is properly typed as strings
        return {
            stdout: String(result.stdout),
            stderr: String(result.stderr)
        };
    } catch (error: any) {
        // Always show error message
        packageLogger.error(`Command failed: ${command}`);

        // Always show stderr on failure (contains important error details like coverage failures)
        if (error.stderr && error.stderr.trim()) {
            packageLogger.error(`❌ STDERR:`);
            error.stderr.split('\n').forEach((line: string) => {
                if (line.trim()) packageLogger.error(`${line}`);
            });
        }

        // Show stdout on failure if available (may contain error context)
        if (error.stdout && error.stdout.trim() && (showOutput === 'full' || showOutput === 'minimal')) {
            packageLogger.info(`📤 STDOUT:`);
            error.stdout.split('\n').forEach((line: string) => {
                if (line.trim()) packageLogger.info(`${line}`);
            });
        }

        // Show full output in debug/verbose mode
        if (showOutput === 'full' || showOutput === 'minimal') {
            if (error.stdout && error.stdout.trim() && showOutput === 'full') {
                packageLogger.debug('STDOUT:');
                packageLogger.debug(error.stdout);
            }
            if (error.stderr && error.stderr.trim() && showOutput === 'full') {
                packageLogger.debug('STDERR:');
                packageLogger.debug(error.stderr);
            }
        }

        // Write error output to log file
        if (logFilePath) {
            await writeToLogFile(`\n[${new Date().toISOString()}] Command failed: ${error.message}`);
            if (error.stdout) {
                await writeToLogFile(`\n=== STDOUT ===\n${error.stdout}`);
            }
            if (error.stderr) {
                await writeToLogFile(`\n=== STDERR ===\n${error.stderr}`);
            }
            if (error.stack) {
                await writeToLogFile(`\n=== STACK TRACE ===\n${error.stack}`);
            }
        }

        throw error;
    }
};

// Create a package-scoped logger that prefixes all messages
const createPackageLogger = (packageName: string, sequenceNumber: number, totalCount: number, isDryRun: boolean = false) => {
    const baseLogger = getLogger();
    const prefix = `[${sequenceNumber}/${totalCount}] ${packageName}:`;
    const dryRunPrefix = isDryRun ? 'DRY RUN: ' : '';

    return {
        info: (message: string, ...args: any[]) => baseLogger.info(`${dryRunPrefix}${prefix} ${message}`, ...args),
        warn: (message: string, ...args: any[]) => baseLogger.warn(`${dryRunPrefix}${prefix} ${message}`, ...args),
        error: (message: string, ...args: any[]) => baseLogger.error(`${dryRunPrefix}${prefix} ${message}`, ...args),
        debug: (message: string, ...args: any[]) => baseLogger.debug(`${dryRunPrefix}${prefix} ${message}`, ...args),
        verbose: (message: string, ...args: any[]) => baseLogger.verbose(`${dryRunPrefix}${prefix} ${message}`, ...args),
        silly: (message: string, ...args: any[]) => baseLogger.silly(`${dryRunPrefix}${prefix} ${message}`, ...args),
    };
};

// Helper function to format subproject error output
const formatSubprojectError = (packageName: string, error: any, _packageInfo?: PackageInfo, _position?: number, _total?: number): string => {
    const lines: string[] = [];

    lines.push(`❌ Command failed in package ${packageName}:`);

    // Format the main error message with indentation
    if (error.message) {
        const indentedMessage = error.message
            .split('\n')
            .map((line: string) => `    ${line}`)
            .join('\n');
        lines.push(indentedMessage);
    }

    // If there's stderr output, show it indented as well
    if (error.stderr && error.stderr.trim()) {
        lines.push('    STDERR:');
        const indentedStderr = error.stderr
            .split('\n')
            .filter((line: string) => line.trim())
            .map((line: string) => `      ${line}`)
            .join('\n');
        lines.push(indentedStderr);
    }

    // If there's stdout output, show it indented as well
    if (error.stdout && error.stdout.trim()) {
        lines.push('    STDOUT:');
        const indentedStdout = error.stdout
            .split('\n')
            .filter((line: string) => line.trim())
            .map((line: string) => `      ${line}`)
            .join('\n');
        lines.push(indentedStdout);
    }


    return lines.join('\n');
};


// Note: PackageInfo, DependencyGraph, scanForPackageJsonFiles, parsePackageJson,
// buildDependencyGraph, and topologicalSort are now imported from ../util/dependencyGraph



// Execute a single package and return execution result
export const executePackage = async (
    packageName: string,
    packageInfo: PackageInfo,
    commandToRun: string,
    runConfig: Config,
    isDryRun: boolean,
    index: number,
    total: number,
    allPackageNames: Set<string>,
    isBuiltInCommand: boolean = false
): Promise<{ success: boolean; error?: any; isTimeoutError?: boolean; skippedNoChanges?: boolean; logFile?: string }> => {
    const packageLogger = createPackageLogger(packageName, index + 1, total, isDryRun);
    const packageDir = packageInfo.path;
    const logger = getLogger();

    // Create log file path for publish commands
    let logFilePath: string | undefined;
    if (isBuiltInCommand && commandToRun.includes('publish')) {
        const outputDir = runConfig.outputDirectory || 'output/kodrdriv';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
        const commandName = commandToRun.split(' ')[1]?.split(' ')[0] || 'command';
        logFilePath = path.join(packageDir, outputDir, `${commandName}_${timestamp}.log`);
    }

    // Determine output level based on flags
    // For publish and commit commands, default to full output to show AI progress and other details
    // For other commands, require --verbose or --debug for output
    const isPublishCommand = isBuiltInCommand && commandToRun.includes('publish');
    const isCommitCommand = isBuiltInCommand && commandToRun.includes('commit');
    let showOutput: 'none' | 'minimal' | 'full' = (isPublishCommand || isCommitCommand) ? 'full' : 'none';
    if (runConfig.debug) {
        showOutput = 'full';
    } else if (runConfig.verbose) {
        showOutput = 'minimal';
    }

    // Show package start info - always visible for progress tracking
    if (runConfig.debug) {
        packageLogger.debug('MULTI_PROJECT_START: Starting package execution | Package: %s | Index: %d/%d | Path: %s | Command: %s | Context: tree execution',
            packageName, index + 1, total, packageDir, commandToRun);
        packageLogger.debug('MULTI_PROJECT_CONTEXT: Execution details | Directory: %s | Built-in Command: %s | Dry Run: %s | Output Level: %s',
            packageDir, isBuiltInCommand, isDryRun, showOutput);

        // Show dependencies if available
        if (packageInfo.dependencies && Array.isArray(packageInfo.dependencies) && packageInfo.dependencies.length > 0) {
            packageLogger.debug('MULTI_PROJECT_DEPS: Package dependencies | Package: %s | Dependencies: [%s]',
                packageName, packageInfo.dependencies.join(', '));
        }
    } else if (runConfig.verbose) {
        packageLogger.verbose(`Starting execution in ${packageDir}`);
    } else {
        // Basic progress info even without flags
        logger.info(`[${index + 1}/${total}] ${packageName}: Running ${commandToRun}...`);
    }

    // Track if publish was skipped due to no changes
    let publishWasSkipped: boolean = false;

    // Track execution timing
    const executionTimer = PerformanceTimer.start(packageLogger, `Package ${packageName} execution`);
    let executionDuration: number | undefined;

    try {
        if (isDryRun && !isBuiltInCommand) {
            // Handle inter-project dependency updates for publish commands in dry run mode
            if (isBuiltInCommand && commandToRun.includes('publish') && publishedVersions.length > 0) {
                let mutexLocked = false;
                try {
                    await globalStateMutex.lock();
                    mutexLocked = true;
                    packageLogger.info('Would check for inter-project dependency updates before publish...');
                    const versionSnapshot = [...publishedVersions]; // Create safe copy
                    globalStateMutex.unlock();
                    mutexLocked = false;
                    await updateInterProjectDependencies(packageDir, versionSnapshot, allPackageNames, packageLogger, isDryRun);
                } catch (error) {
                    if (mutexLocked) {
                        globalStateMutex.unlock();
                    }
                    throw error;
                }
            }

            // Use main logger for the specific message tests expect
            logger.info(`DRY RUN: Would execute: ${commandToRun}`);
            if (runConfig.debug || runConfig.verbose) {
                packageLogger.info(`In directory: ${packageDir}`);
            }
        } else {
            // Change to the package directory and run the command
            const originalCwd = process.cwd();
            try {
                // Validate package directory exists before changing to it
                try {
                    await fs.access(packageDir);
                    const stat = await fs.stat(packageDir);
                    if (!stat.isDirectory()) {
                        throw new Error(`Path is not a directory: ${packageDir}`);
                    }
                } catch (accessError: any) {
                    throw new Error(`Cannot access package directory: ${packageDir} - ${accessError.message}`);
                }

                process.chdir(packageDir);
                if (runConfig.debug) {
                    packageLogger.debug(`Changed to directory: ${packageDir}`);
                }

                // Handle dependency updates for publish commands before executing (skip during dry run)
                // Wrap in git lock to prevent parallel packages from conflicting with npm install and git operations
                if (!isDryRun && isBuiltInCommand && commandToRun.includes('publish')) {
                    await runGitWithLock(packageDir, async () => {
                        let hasAnyUpdates = false;

                        // First, update all scoped dependencies from npm registry
                        const hasScopedUpdates = await updateScopedDependencies(packageDir, packageLogger, isDryRun, runConfig);
                        hasAnyUpdates = hasAnyUpdates || hasScopedUpdates;

                        // Then update inter-project dependencies based on previously published packages
                        if (publishedVersions.length > 0) {
                            packageLogger.info('Updating inter-project dependencies based on previously published packages...');
                            const hasInterProjectUpdates = await updateInterProjectDependencies(packageDir, publishedVersions, allPackageNames, packageLogger, isDryRun);
                            hasAnyUpdates = hasAnyUpdates || hasInterProjectUpdates;
                        }

                        // If either type of update occurred, commit the changes
                        if (hasAnyUpdates) {
                            // Commit the dependency updates using kodrdriv commit
                            packageLogger.info('Committing dependency updates...');
                            packageLogger.info('⏱️  This step may take a few minutes as it generates a commit message using AI...');

                            // Add timeout wrapper around commit execution
                            const commitTimeoutMs = 300000; // 5 minutes
                            const commitPromise = Commit.commit({...runConfig, dryRun: false});
                            const timeoutPromise = new Promise<never>((_, reject) => {
                                setTimeout(() => reject(new Error(`Commit operation timed out after ${commitTimeoutMs/1000} seconds`)), commitTimeoutMs);
                            });

                            // Add progress indicator
                            let progressInterval: NodeJS.Timeout | null = null;
                            try {
                                // Start progress indicator
                                progressInterval = setInterval(() => {
                                    packageLogger.info('⏳ Still generating commit message... (this can take 1-3 minutes)');
                                }, 30000); // Every 30 seconds

                                await Promise.race([commitPromise, timeoutPromise]);
                                packageLogger.info('✅ Dependency updates committed successfully');
                            } catch (commitError: any) {
                                if (commitError.message.includes('timed out')) {
                                    packageLogger.error(`❌ Commit operation timed out after ${commitTimeoutMs/1000} seconds`);
                                    packageLogger.error('This usually indicates an issue with the AI service or very large changes');
                                    packageLogger.error('You may need to manually commit the dependency updates');
                                } else {
                                    packageLogger.warn(`Failed to commit dependency updates: ${commitError.message}`);
                                }
                                // Continue with publish anyway - the updates are still in place
                            } finally {
                                if (progressInterval) {
                                    clearInterval(progressInterval);
                                }
                            }
                        }
                    }, `${packageName}: dependency updates`);
                }

                // Optimize precommit commands for custom commands (not built-in)
                let effectiveCommandToRun = commandToRun;
                let optimizationInfo: { skipped: { clean: boolean; test: boolean }; reasons: { clean?: string; test?: string } } | null = null;

                if (!isBuiltInCommand && !isDryRun) {
                    const isPrecommitCommand = commandToRun.includes('precommit') || commandToRun.includes('pre-commit');
                    if (isPrecommitCommand) {
                        try {
                            const optimization = await optimizePrecommitCommand(packageDir, commandToRun);
                            effectiveCommandToRun = optimization.optimizedCommand;
                            optimizationInfo = { skipped: optimization.skipped, reasons: optimization.reasons };

                            if (optimization.skipped.clean || optimization.skipped.test) {
                                const skippedParts: string[] = [];
                                if (optimization.skipped.clean) {
                                    skippedParts.push(`clean (${optimization.reasons.clean})`);
                                }
                                if (optimization.skipped.test) {
                                    skippedParts.push(`test (${optimization.reasons.test})`);
                                }
                                packageLogger.info(`⚡ Optimized: Skipped ${skippedParts.join(', ')}`);
                                if (runConfig.verbose || runConfig.debug) {
                                    packageLogger.info(`   Original: ${commandToRun}`);
                                    packageLogger.info(`   Optimized: ${effectiveCommandToRun}`);
                                }
                            }
                        } catch (error: any) {
                            // If optimization fails, fall back to original command
                            logger.debug(`Precommit optimization failed for ${packageName}: ${error.message}`);
                        }
                    }
                }

                if (runConfig.debug || runConfig.verbose) {
                    if (isBuiltInCommand) {
                        packageLogger.info(`Executing built-in command: ${commandToRun}`);
                    } else {
                        packageLogger.info(`Executing command: ${effectiveCommandToRun}`);
                    }
                }

                // For built-in commands, shell out to a separate kodrdriv process
                // This preserves individual project configurations
                if (isBuiltInCommand) {
                    // Extract the command name from "kodrdriv <command> [args...]"
                    // Split by space and take the second element (after "kodrdriv")
                    const commandParts = commandToRun.replace(/^kodrdriv\s+/, '').split(/\s+/);
                    const builtInCommandName = commandParts[0];
                    if (runConfig.debug) {
                        packageLogger.debug(`Shelling out to separate kodrdriv process for ${builtInCommandName} command`);
                    }

                    // Add progress indication for publish commands
                    if (builtInCommandName === 'publish') {
                        packageLogger.info('🚀 Starting publish process...');
                        packageLogger.info('⏱️  This may take several minutes (AI processing, PR creation, etc.)');
                    }

                    // Ensure dry-run propagates to subprocess even during overall dry-run mode
                    let effectiveCommand = runConfig.dryRun && !commandToRun.includes('--dry-run')
                        ? `${commandToRun} --dry-run`
                        : commandToRun;

                    // For commit commands, ensure --sendit is used to avoid interactive prompts
                    // This prevents hanging when running via tree command
                    if (builtInCommandName === 'commit' && !effectiveCommand.includes('--sendit') && !runConfig.dryRun) {
                        effectiveCommand = `${effectiveCommand} --sendit`;
                        packageLogger.info('💡 Auto-adding --sendit flag to avoid interactive prompts in tree mode');
                    }

                    // Set timeout based on command type
                    let commandTimeoutMs: number;
                    if (builtInCommandName === 'publish') {
                        commandTimeoutMs = 1800000; // 30 minutes for publish commands
                        packageLogger.info(`⏰ Setting timeout of ${commandTimeoutMs/60000} minutes for publish command`);
                    } else if (builtInCommandName === 'commit') {
                        commandTimeoutMs = 600000; // 10 minutes for commit commands (AI processing can take time)
                        packageLogger.info(`⏰ Setting timeout of ${commandTimeoutMs/60000} minutes for commit command`);
                    } else {
                        commandTimeoutMs = 300000; // 5 minutes default for other commands
                    }

                    const commandPromise = runWithLogging(effectiveCommand, packageLogger, {}, showOutput, logFilePath);
                    const commandTimeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error(`Command timed out after ${commandTimeoutMs/60000} minutes`)), commandTimeoutMs);
                    });

                    try {
                        const startTime = Date.now();
                        const { stdout, stderr } = await Promise.race([commandPromise, commandTimeoutPromise]);
                        executionDuration = Date.now() - startTime;
                        // Detect explicit skip marker from publish to avoid propagating versions
                        // Check both stdout (where we now write it) and stderr (winston logger output, for backward compat)
                        if (builtInCommandName === 'publish' &&
                            ((stdout && stdout.includes('KODRDRIV_PUBLISH_SKIPPED')) ||
                             (stderr && stderr.includes('KODRDRIV_PUBLISH_SKIPPED')))) {
                            packageLogger.info('Publish skipped for this package; will not record or propagate a version.');
                            publishWasSkipped = true;
                        }
                    } catch (error: any) {
                        if (error.message.includes('timed out')) {
                            packageLogger.error(`❌ ${builtInCommandName} command timed out after ${commandTimeoutMs/60000} minutes`);
                            packageLogger.error('This usually indicates the command is stuck waiting for user input or an external service');
                            throw error;
                        }
                        throw error;
                    }
                } else {
                    // For custom commands, use the existing logic
                    const startTime = Date.now();
                    await runWithLogging(effectiveCommandToRun, packageLogger, {}, showOutput, logFilePath);
                    executionDuration = Date.now() - startTime;
                }

                // Track published version after successful publish (skip during dry run)
                if (!isDryRun && isBuiltInCommand && commandToRun.includes('publish')) {
                    // If publish was skipped, do not record a version
                    if (publishWasSkipped) {
                        packageLogger.verbose('Skipping version tracking due to earlier skip.');
                    } else {
                        // Only record a published version if a new tag exists (avoid recording for skipped publishes)
                        const publishedVersion = await extractPublishedVersion(packageDir, packageLogger);
                        if (publishedVersion) {
                            let mutexLocked = false;
                            try {
                                await globalStateMutex.lock();
                                mutexLocked = true;
                                publishedVersions.push(publishedVersion);
                                packageLogger.info(`Tracked published version: ${publishedVersion.packageName}@${publishedVersion.version}`);
                                globalStateMutex.unlock();
                                mutexLocked = false;
                            } catch (error) {
                                if (mutexLocked) {
                                    globalStateMutex.unlock();
                                }
                                throw error;
                            }
                        }
                    }
                }

                // Record test run if tests were executed (not skipped)
                if (!isDryRun && !isBuiltInCommand && effectiveCommandToRun.includes('test') &&
                    (!optimizationInfo || !optimizationInfo.skipped.test)) {
                    try {
                        await recordTestRun(packageDir);
                    } catch (error: any) {
                        logger.debug(`Failed to record test run for ${packageName}: ${error.message}`);
                    }
                }

                // End timing and show duration
                if (executionDuration !== undefined) {
                    executionTimer.end(`Package ${packageName} execution`);
                    const seconds = (executionDuration / 1000).toFixed(1);
                    if (runConfig.debug || runConfig.verbose) {
                        packageLogger.info(`⏱️  Execution time: ${seconds}s`);
                    } else if (!isPublishCommand && !isCommitCommand) {
                        // Show timing in completion message (publish/commit commands have their own completion message)
                        logger.info(`[${index + 1}/${total}] ${packageName}: ✅ Completed (${seconds}s)`);
                    }
                } else {
                    executionTimer.end(`Package ${packageName} execution`);
                    if (runConfig.debug || runConfig.verbose) {
                        packageLogger.info(`Command completed successfully`);
                    } else if (!isPublishCommand && !isCommitCommand) {
                        // Basic completion info (publish/commit commands have their own completion message)
                        logger.info(`[${index + 1}/${total}] ${packageName}: ✅ Completed`);
                    }
                }
            } finally {
                // Safely restore working directory
                try {
                    // Validate original directory still exists before changing back
                    const fs = await import('fs/promises');
                    await fs.access(originalCwd);
                    process.chdir(originalCwd);
                    if (runConfig.debug) {
                        packageLogger.debug(`Restored working directory to: ${originalCwd}`);
                    }
                } catch (restoreError: any) {
                    // If we can't restore to original directory, at least log the issue
                    packageLogger.error(`Failed to restore working directory to ${originalCwd}: ${restoreError.message}`);
                    packageLogger.error(`Current working directory is now: ${process.cwd()}`);
                    // Don't throw here to avoid masking the original error
                }
            }
        }

        // Show completion status (for publish/commit commands, this supplements the timing message above)
        if (runConfig.debug || runConfig.verbose) {
            if (publishWasSkipped) {
                packageLogger.info(`⊘ Skipped (no code changes)`);
            } else {
                packageLogger.info(`✅ Completed successfully`);
            }
        } else if (isPublishCommand || isCommitCommand) {
            // For publish/commit commands, always show completion even without verbose
            // Include timing if available
            const timeStr = executionDuration !== undefined ? ` (${(executionDuration / 1000).toFixed(1)}s)` : '';
            if (publishWasSkipped) {
                logger.info(`[${index + 1}/${total}] ${packageName}: ⊘ Skipped (no code changes)`);
            } else {
                logger.info(`[${index + 1}/${total}] ${packageName}: ✅ Completed${timeStr}`);
            }
        }

        // Ensure timing is recorded even if there was an early return
        if (executionDuration === undefined) {
            executionDuration = executionTimer.end(`Package ${packageName} execution`);
        }

        return { success: true, skippedNoChanges: publishWasSkipped, logFile: logFilePath };
    } catch (error: any) {
        // Record timing even on error
        if (executionDuration === undefined) {
            executionDuration = executionTimer.end(`Package ${packageName} execution`);
            const seconds = (executionDuration / 1000).toFixed(1);
            if (runConfig.debug || runConfig.verbose) {
                packageLogger.error(`⏱️  Execution time before failure: ${seconds}s`);
            }
        }

        if (runConfig.debug || runConfig.verbose) {
            packageLogger.error(`❌ Execution failed: ${error.message}`);
        } else {
            logger.error(`[${index + 1}/${total}] ${packageName}: ❌ Failed - ${error.message}`);
        }

        // Always show stderr if available (contains important error details)
        // Note: runWithLogging already logs stderr, but we show it here too for visibility
        // when error is caught at this level (e.g., from timeout wrapper)
        if (error.stderr && error.stderr.trim() && !runConfig.debug && !runConfig.verbose) {
            // Extract key error lines from stderr (coverage failures, test failures, etc.)
            const stderrLines = error.stderr.split('\n').filter((line: string) => {
                const trimmed = line.trim();
                return trimmed && (
                    trimmed.includes('ERROR:') ||
                    trimmed.includes('FAIL') ||
                    trimmed.includes('coverage') ||
                    trimmed.includes('threshold') ||
                    trimmed.includes('fatal:') ||
                    trimmed.startsWith('❌')
                );
            });
            if (stderrLines.length > 0) {
                logger.error(`   Error details:`);
                stderrLines.slice(0, 10).forEach((line: string) => {
                    logger.error(`   ${line.trim()}`);
                });
                if (stderrLines.length > 10) {
                    logger.error(`   ... and ${stderrLines.length - 10} more error lines (use --verbose to see full output)`);
                }
            }
        }

        // Check if this is a timeout error
        const errorMessage = error.message?.toLowerCase() || '';
        const isTimeoutError = errorMessage && (
            errorMessage.includes('timeout waiting for pr') ||
            errorMessage.includes('timeout waiting for release workflows') ||
            errorMessage.includes('timeout reached') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('timed out') ||
            errorMessage.includes('timed_out')
        );

        return { success: false, error, isTimeoutError, logFile: logFilePath };
    }
};

/**
 * Generate a dry-run preview showing what would happen without executing
 */
const generateDryRunPreview = async (
    dependencyGraph: DependencyGraph,
    buildOrder: string[],
    command: string,
    runConfig: Config
): Promise<string> => {
    const lines: string[] = [];

    lines.push('');
    lines.push('🔍 DRY RUN MODE - No changes will be made');
    lines.push('');
    lines.push('Build order determined:');
    lines.push('');

    // Group packages by dependency level
    const levels: string[][] = [];
    const packageLevels = new Map<string, number>();

    for (const pkg of buildOrder) {
        const deps = dependencyGraph.edges.get(pkg) || new Set();
        let maxDepLevel = -1;
        for (const dep of deps) {
            const depLevel = packageLevels.get(dep) ?? 0;
            maxDepLevel = Math.max(maxDepLevel, depLevel);
        }
        const pkgLevel = maxDepLevel + 1;
        packageLevels.set(pkg, pkgLevel);

        if (!levels[pkgLevel]) {
            levels[pkgLevel] = [];
        }
        levels[pkgLevel].push(pkg);
    }

    // Show packages grouped by level
    for (let i = 0; i < levels.length; i++) {
        const levelPackages = levels[i];
        lines.push(`Level ${i + 1}: (${levelPackages.length} package${levelPackages.length === 1 ? '' : 's'})`);

        for (const pkg of levelPackages) {
            const pkgInfo = dependencyGraph.packages.get(pkg);
            if (!pkgInfo) continue;

            // Check if package has changes (for publish command)
            const isPublish = command.includes('publish');
            let status = '📝 Has changes, will execute';

            if (isPublish) {
                try {
                    // Check git diff to see if there are code changes
                    const { stdout } = await runSecure('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: pkgInfo.path });
                    const changedFiles = stdout.split('\n').filter(Boolean);
                    const nonVersionFiles = changedFiles.filter(f => f !== 'package.json' && f !== 'package-lock.json');

                    if (changedFiles.length === 0) {
                        status = '⊘ No changes, will skip';
                    } else if (nonVersionFiles.length === 0) {
                        status = '⊘ Only version bump, will skip';
                    } else {
                        status = `📝 Has changes (${nonVersionFiles.length} files), will publish`;
                    }
                } catch {
                    // If we can't check git status, assume changes
                    status = '📝 Will execute';
                }
            }

            lines.push(`  ${pkg}`);
            lines.push(`    Status: ${status}`);
            lines.push(`    Path: ${pkgInfo.path}`);
        }
        lines.push('');
    }

    lines.push('Summary:');
    lines.push(`  Total packages: ${buildOrder.length}`);
    lines.push(`  Dependency levels: ${levels.length}`);
    lines.push(`  Command: ${command}`);

    if (runConfig.tree?.maxConcurrency) {
        lines.push(`  Max concurrency: ${runConfig.tree.maxConcurrency}`);
    }

    lines.push('');
    lines.push('To execute for real, run the same command without --dry-run');
    lines.push('');

    return lines.join('\n');
};

// Add a simple status check function
const checkTreePublishStatus = async (): Promise<void> => {
    const logger = getLogger();
    try {
        // Check for running kodrdriv processes
        const { stdout } = await runSecure('ps', ['aux'], {});
        const kodrdrivProcesses = stdout.split('\n').filter((line: string) =>
            line.includes('kodrdriv') &&
            !line.includes('grep') &&
            !line.includes('ps aux') &&
            !line.includes('tree --status') // Exclude the current status command
        );

        if (kodrdrivProcesses.length > 0) {
            logger.info('🔍 Found running kodrdriv processes:');
            kodrdrivProcesses.forEach((process: string) => {
                const parts = process.trim().split(/\s+/);
                const pid = parts[1];
                const command = parts.slice(10).join(' ');
                logger.info(`  PID ${pid}: ${command}`);
            });
        } else {
            logger.info('No kodrdriv processes currently running');
        }
    } catch (error) {
        logger.warn('Could not check process status:', error);
    }
};

export const execute = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const isDryRun = runConfig.dryRun || false;
    const isContinue = runConfig.tree?.continue || false;
    const promotePackage = runConfig.tree?.promote;

    // Debug logging
    logger.debug('Tree config:', JSON.stringify(runConfig.tree, null, 2));
    logger.debug('Status flag:', (runConfig.tree as any)?.status);
    logger.debug('Full runConfig:', JSON.stringify(runConfig, null, 2));

    // Handle status check
    if ((runConfig.tree as any)?.status) {
        logger.info('🔍 Checking for running kodrdriv processes...');
        await checkTreePublishStatus();
        return 'Status check completed';
    }

    // Handle promote mode
    if (promotePackage) {
        logger.info(`Promoting package '${promotePackage}' to completed status...`);
        await promotePackageToCompleted(promotePackage, runConfig.outputDirectory);
        logger.info(`✅ Package '${promotePackage}' has been marked as completed.`);
        logger.info('You can now run the tree command with --continue to resume from the next package.');
        return `Package '${promotePackage}' promoted to completed status.`;
    }

    // Handle order command - show execution order
    if (runConfig.tree?.order) {
        logger.info('📦 Analyzing package execution order...\n');

        const directories = runConfig.tree?.directories || [process.cwd()];
        const excludedPatterns = runConfig.tree?.exclude || [];

        let allPackageJsonPaths: string[] = [];
        for (const targetDirectory of directories) {
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        if (allPackageJsonPaths.length === 0) {
            return 'No packages found';
        }

        const dependencyGraph = await buildDependencyGraph(allPackageJsonPaths);
        const buildOrder = topologicalSort(dependencyGraph);

        // Build a map of package name -> dependency versions from package.json
        const storage = createStorage();
        const packageDependencyVersions = new Map<string, Map<string, string>>();

        for (const pkgName of buildOrder) {
            const pkgInfo = dependencyGraph.packages.get(pkgName);
            if (pkgInfo) {
                const packageJsonPath = path.join(pkgInfo.path, 'package.json');
                try {
                    const content = await storage.readFile(packageJsonPath, 'utf-8');
                    const parsed = safeJsonParse(content, packageJsonPath);
                    const packageJson = validatePackageJson(parsed, packageJsonPath);

                    const depVersions = new Map<string, string>();
                    const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

                    for (const section of depSections) {
                        if (packageJson[section]) {
                            for (const [depName, depVersion] of Object.entries(packageJson[section])) {
                                // Only store if it's a local dependency
                                if (dependencyGraph.packages.has(depName)) {
                                    depVersions.set(depName, depVersion as string);
                                }
                            }
                        }
                    }
                    packageDependencyVersions.set(pkgName, depVersions);
                } catch {
                    // If we can't read the package.json, just skip
                }
            }
        }

        // Group packages by their dependency level for visualization
        const packageLevels = new Map<string, number>();
        const calculateLevel = (pkgName: string, visited: Set<string> = new Set()): number => {
            if (visited.has(pkgName)) return 0;
            visited.add(pkgName);

            const deps = dependencyGraph.edges.get(pkgName) || new Set();
            if (deps.size === 0) return 0;

            let maxDepLevel = 0;
            for (const dep of deps) {
                maxDepLevel = Math.max(maxDepLevel, calculateLevel(dep, visited) + 1);
            }
            return maxDepLevel;
        };

        // Calculate levels for all packages
        for (const pkgName of buildOrder) {
            packageLevels.set(pkgName, calculateLevel(pkgName));
        }

        // Group packages by level
        const levelGroups = new Map<number, string[]>();
        for (const [pkgName, level] of packageLevels) {
            if (!levelGroups.has(level)) {
                levelGroups.set(level, []);
            }
            levelGroups.get(level)!.push(pkgName);
        }

        // Sort levels for display
        const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

        // Display output
        logger.info('='.repeat(60));
        logger.info('EXECUTION ORDER (topological sort)');
        logger.info('='.repeat(60));
        logger.info('');

        for (const level of sortedLevels) {
            const packages = levelGroups.get(level)!;
            const levelLabel = level === 0 ? 'Level 0 (no local dependencies)' : `Level ${level}`;
            logger.info(`--- ${levelLabel} ---`);

            for (const pkgName of packages) {
                const pkgInfo = dependencyGraph.packages.get(pkgName);
                const localDeps = dependencyGraph.edges.get(pkgName) || new Set();
                const version = pkgInfo?.version || 'unknown';
                const depVersions = packageDependencyVersions.get(pkgName);

                logger.info(`  ${pkgName}@${version}`);

                if (localDeps.size > 0 && depVersions) {
                    const depsWithVersions = Array.from(localDeps).map(dep => {
                        const depVersion = depVersions.get(dep) || '?';
                        return `${dep}@${depVersion}`;
                    });
                    logger.info(`    └─ depends on: ${depsWithVersions.join(', ')}`);
                } else if (localDeps.size > 0) {
                    logger.info(`    └─ depends on: ${Array.from(localDeps).join(', ')}`);
                }

                if (pkgInfo) {
                    logger.verbose(`    path: ${pkgInfo.path}`);
                }
            }
            logger.info('');
        }

        logger.info('='.repeat(60));
        logger.info('SUMMARY');
        logger.info('='.repeat(60));
        logger.info(`Total packages: ${buildOrder.length}`);
        logger.info(`Dependency levels: ${sortedLevels.length}`);
        logger.info('');
        logger.info('Sequential execution order:');
        buildOrder.forEach((pkg, idx) => {
            const pkgInfo = dependencyGraph.packages.get(pkg);
            const version = pkgInfo?.version || 'unknown';
            logger.info(`  ${idx + 1}. ${pkg}@${version}`);
        });

        return `Analyzed ${buildOrder.length} packages across ${sortedLevels.length} dependency levels`;
    }

    // Handle audit-branches command
    if (runConfig.tree?.auditBranches) {
        logger.info('🔍 Auditing branch state across all packages...');

        const directories = runConfig.tree?.directories || [process.cwd()];
        const excludedPatterns = runConfig.tree?.exclude || [];

        let allPackageJsonPaths: string[] = [];
        for (const targetDirectory of directories) {
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        if (allPackageJsonPaths.length === 0) {
            return 'No packages found';
        }

        const dependencyGraph = await buildDependencyGraph(allPackageJsonPaths);
        const packages = Array.from(dependencyGraph.packages.values()).map(pkg => ({
            name: pkg.name,
            path: pkg.path,
        }));

        const { auditBranchState, formatAuditResults } = await import('../utils/branchState');
        const { getRemoteDefaultBranch } = await import('@eldrforge/git-tools');

        // For publish workflows, check branch consistency, merge conflicts, and existing PRs
        // Don't pass an expected branch - let the audit find the most common branch
        let targetBranch = runConfig.publish?.targetBranch;

        if (!targetBranch) {
            // Try to detect default branch from the first package that is a git repo
            const firstGitPkg = packages.find(pkg => isInGitRepository(pkg.path));
            if (firstGitPkg) {
                try {
                    // Cast to any to avoid type mismatch with node_modules version
                    targetBranch = await (getRemoteDefaultBranch as any)(firstGitPkg.path) || 'main';
                } catch {
                    targetBranch = 'main';
                }
            } else {
                targetBranch = 'main';
            }
        }

        logger.info(`Checking for merge conflicts with '${targetBranch}' and existing pull requests...`);

        const auditResult = await auditBranchState(packages, undefined, {
            targetBranch,
            checkPR: true,
            checkConflicts: true,
            concurrency: runConfig.tree?.maxConcurrency || 10,
        });
        const formatted = formatAuditResults(auditResult);

        logger.info('\n' + formatted);

        if (auditResult.issuesFound > 0) {
            logger.warn(`\n⚠️  Found issues in ${auditResult.issuesFound} package(s). Review the fixes above.`);
            return `Branch audit complete: ${auditResult.issuesFound} package(s) need attention`;
        }

        logger.info(`\n✅ All ${auditResult.goodPackages} package(s) are in good state!`);
        return `Branch audit complete: All packages OK`;
    }

    // Handle parallel execution recovery commands
    const { loadRecoveryManager } = await import('@eldrforge/tree-execution');

    // Handle status-parallel command
    if (runConfig.tree?.statusParallel) {
        logger.info('📊 Checking parallel execution status...');

        // Need to build dependency graph first
        const directories = runConfig.tree?.directories || [process.cwd()];
        const excludedPatterns = runConfig.tree?.exclude || [];

        let allPackageJsonPaths: string[] = [];
        for (const targetDirectory of directories) {
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        if (allPackageJsonPaths.length === 0) {
            return 'No packages found';
        }

        const dependencyGraph = await buildDependencyGraph(allPackageJsonPaths);
        const recoveryManager = await loadRecoveryManager(dependencyGraph, runConfig.outputDirectory);

        if (!recoveryManager) {
            logger.info('No parallel execution checkpoint found');
            return 'No active parallel execution found';
        }

        const status = await recoveryManager.showStatus();
        logger.info('\n' + status);
        return status;
    }

    // Handle validate-state command
    if (runConfig.tree?.validateState) {
        logger.info('🔍 Validating checkpoint state...');

        const directories = runConfig.tree?.directories || [process.cwd()];
        const excludedPatterns = runConfig.tree?.exclude || [];

        let allPackageJsonPaths: string[] = [];
        for (const targetDirectory of directories) {
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        if (allPackageJsonPaths.length === 0) {
            return 'No packages found';
        }

        const dependencyGraph = await buildDependencyGraph(allPackageJsonPaths);
        const recoveryManager = await loadRecoveryManager(dependencyGraph, runConfig.outputDirectory);

        if (!recoveryManager) {
            logger.info('No checkpoint found to validate');
            return 'No checkpoint found';
        }

        const validation = recoveryManager.validateState();

        if (validation.valid) {
            logger.info('✅ Checkpoint state is valid');
        } else {
            logger.error('❌ Checkpoint state has issues:');
            for (const issue of validation.issues) {
                logger.error(`  • ${issue}`);
            }
        }

        if (validation.warnings.length > 0) {
            logger.warn('⚠️  Warnings:');
            for (const warning of validation.warnings) {
                logger.warn(`  • ${warning}`);
            }
        }

        return validation.valid ? 'Checkpoint is valid' : 'Checkpoint has issues';
    }

    // Handle parallel execution recovery options (must happen before main execution)
    const hasRecoveryOptions = runConfig.tree?.markCompleted || runConfig.tree?.skipPackages ||
                               runConfig.tree?.retryFailed || runConfig.tree?.skipFailed ||
                               runConfig.tree?.resetPackage;

    if (hasRecoveryOptions && runConfig.tree) {
        logger.info('🔧 Applying recovery options...');

        // Build dependency graph
        const directories = runConfig.tree.directories || [process.cwd()];
        const excludedPatterns = runConfig.tree.exclude || [];

        let allPackageJsonPaths: string[] = [];
        for (const targetDirectory of directories) {
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        const dependencyGraph = await buildDependencyGraph(allPackageJsonPaths);
        const recoveryManager = await loadRecoveryManager(dependencyGraph, runConfig.outputDirectory);

        if (!recoveryManager) {
            logger.error('No checkpoint found for recovery');
            throw new Error('No checkpoint found. Cannot apply recovery options without an existing checkpoint.');
        }

        await recoveryManager.applyRecoveryOptions({
            markCompleted: runConfig.tree.markCompleted,
            skipPackages: runConfig.tree.skipPackages,
            retryFailed: runConfig.tree.retryFailed,
            skipFailed: runConfig.tree.skipFailed,
            resetPackage: runConfig.tree.resetPackage,
            maxRetries: runConfig.tree.retry?.maxAttempts
        });

        logger.info('✅ Recovery options applied');

        // If not also continuing, just return
        if (!isContinue) {
            return 'Recovery options applied. Use --continue to resume execution.';
        }
    }

    // Handle continue mode
    if (isContinue) {
        // For parallel execution, the checkpoint is managed by DynamicTaskPool/CheckpointManager
        // For sequential execution, we use the legacy context file
        const isParallelMode = runConfig.tree?.parallel;

        if (!isParallelMode) {
            // Sequential execution: load legacy context
            const savedContext = await loadExecutionContext(runConfig.outputDirectory);
            if (savedContext) {
                logger.info('Continuing previous tree execution...');
                logger.info(`Original command: ${savedContext.command}`);
                logger.info(`Started: ${savedContext.startTime.toISOString()}`);
                logger.info(`Previously completed: ${savedContext.completedPackages.length}/${savedContext.buildOrder.length} packages`);

                // Restore state safely
                let mutexLocked = false;
                try {
                    await globalStateMutex.lock();
                    mutexLocked = true;
                    publishedVersions = savedContext.publishedVersions;
                    globalStateMutex.unlock();
                    mutexLocked = false;
                } catch (error) {
                    if (mutexLocked) {
                        globalStateMutex.unlock();
                    }
                    throw error;
                }
                executionContext = savedContext;

                // Use original config but allow some overrides (like dry run)
                runConfig = {
                    ...savedContext.originalConfig,
                    dryRun: runConfig.dryRun, // Allow dry run override
                    outputDirectory: runConfig.outputDirectory || savedContext.originalConfig.outputDirectory
                };
            } else {
                logger.warn('No previous execution context found. Starting new execution...');
            }
        } else {
            // Parallel execution: checkpoint is managed by DynamicTaskPool
            // Just log that we're continuing - the actual checkpoint loading happens in DynamicTaskPool
            logger.info('Continuing previous parallel execution...');
        }
    } else {
        // Reset published versions tracking for new tree execution
        publishedVersions = [];
        executionContext = null;
    }

    // Check if we're in built-in command mode (tree command with second argument)
    const builtInCommand = runConfig.tree?.builtInCommand;
    const supportedBuiltInCommands = ['commit', 'release', 'publish', 'link', 'unlink', 'development', 'branches', 'run', 'checkout', 'updates', 'precommit', 'pull'];

    if (builtInCommand && !supportedBuiltInCommands.includes(builtInCommand)) {
        throw new Error(`Unsupported built-in command: ${builtInCommand}. Supported commands: ${supportedBuiltInCommands.join(', ')}`);
    }

    // Handle run subcommand - convert space-separated scripts to npm run commands
    if (builtInCommand === 'run') {
        const packageArgument = runConfig.tree?.packageArgument;
        if (!packageArgument) {
            throw new Error('run subcommand requires script names. Usage: kodrdriv tree run "clean build test"');
        }

        // Split the package argument by spaces to get individual script names
        const scripts = packageArgument.trim().split(/\s+/).filter(script => script.length > 0);

        if (scripts.length === 0) {
            throw new Error('run subcommand requires at least one script name. Usage: kodrdriv tree run "clean build test"');
        }

        // Convert to npm run commands joined with &&
        const npmCommands = scripts.map(script => `npm run ${script}`).join(' && ');

        // Set this as the custom command to run
        runConfig.tree = {
            ...runConfig.tree,
            cmd: npmCommands
        };

        // Clear the built-in command since we're now using custom command mode
        runConfig.tree.builtInCommand = undefined;

        logger.info(`Converting run subcommand to: ${npmCommands}`);

        // Store scripts for later validation
        (runConfig as any).__scriptsToValidate = scripts;
    }

    // Determine the target directories - either specified or current working directory
    const directories = runConfig.tree?.directories || [process.cwd()];

    // Handle link status subcommand
    if (builtInCommand === 'link' && runConfig.tree?.packageArgument === 'status') {
        // For tree link status, we want to show status across all packages
        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Running link status across workspace...`);

        // Create a config that will be passed to the link command
        const linkConfig: Config = {
            ...runConfig,
            tree: {
                ...runConfig.tree,
                directories: directories
            }
        };

        try {
            const result = await Link.execute(linkConfig, 'status');
            return result;
        } catch (error: any) {
            logger.error(`Link status failed: ${error.message}`);
            throw error;
        }
    }

    // Handle unlink status subcommand
    if (builtInCommand === 'unlink' && runConfig.tree?.packageArgument === 'status') {
        // For tree unlink status, we want to show status across all packages
        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Running unlink status across workspace...`);

        // Create a config that will be passed to the unlink command
        const unlinkConfig: Config = {
            ...runConfig,
            tree: {
                ...runConfig.tree,
                directories: directories
            }
        };

        try {
            const result = await Unlink.execute(unlinkConfig, 'status');
            return result;
        } catch (error: any) {
            logger.error(`Unlink status failed: ${error.message}`);
            throw error;
        }
    }

    if (directories.length === 1) {
        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Analyzing workspace at: ${directories[0]}`);
    } else {
        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Analyzing workspaces at: ${directories.join(', ')}`);
    }

    try {
        // Get exclusion patterns from config, fallback to empty array
        const excludedPatterns = runConfig.tree?.exclude || [];

        if (excludedPatterns.length > 0) {
            logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Using exclusion patterns: ${excludedPatterns.join(', ')}`);
        }

        // Scan for package.json files across all directories
        logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Scanning for package.json files...`);
        let allPackageJsonPaths: string[] = [];

        for (const targetDirectory of directories) {
            logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Scanning directory: ${targetDirectory}`);
            const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, excludedPatterns);
            allPackageJsonPaths = allPackageJsonPaths.concat(packageJsonPaths);
        }

        const packageJsonPaths = allPackageJsonPaths;

        if (packageJsonPaths.length === 0) {
            const directoriesStr = directories.join(', ');
            const message = `No package.json files found in subdirectories of: ${directoriesStr}`;
            logger.warn(message);
            return message;
        }

        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Found ${packageJsonPaths.length} package.json files`);

        // Build dependency graph
        logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Building dependency graph...`);
        const dependencyGraph = await buildDependencyGraph(packageJsonPaths);

        // Perform topological sort to determine build order
        logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Determining build order...`);
        let buildOrder = topologicalSort(dependencyGraph);

        // Handle start-from functionality if specified
        const startFrom = runConfig.tree?.startFrom;
        if (startFrom) {
            logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Looking for start package: ${startFrom}`);

            // Resolve the actual package name (can be package name or directory name)
            let startPackageName: string | null = null;
            for (const [pkgName, pkgInfo] of dependencyGraph.packages) {
                const dirName = path.basename(pkgInfo.path);
                if (dirName === startFrom || pkgName === startFrom) {
                    startPackageName = pkgName;
                    break;
                }
            }

            if (!startPackageName) {
                // Check if the package exists but was excluded across all directories
                let allPackageJsonPathsForCheck: string[] = [];
                for (const targetDirectory of directories) {
                    const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, []); // No exclusions
                    allPackageJsonPathsForCheck = allPackageJsonPathsForCheck.concat(packageJsonPaths);
                }
                let wasExcluded = false;

                for (const packageJsonPath of allPackageJsonPathsForCheck) {
                    try {
                        const packageInfo = await parsePackageJson(packageJsonPath);
                        const dirName = path.basename(packageInfo.path);

                        if (dirName === startFrom || packageInfo.name === startFrom) {
                            // Check if this package was excluded
                            if (shouldExclude(packageJsonPath, excludedPatterns)) {
                                wasExcluded = true;
                                break;
                            }
                        }
                    } catch {
                        // Skip invalid package.json files
                        continue;
                    }
                }

                if (wasExcluded) {
                    const excludedPatternsStr = excludedPatterns.join(', ');
                    throw new Error(`Package directory '${startFrom}' was excluded by exclusion patterns: ${excludedPatternsStr}. Remove the exclusion pattern or choose a different starting package.`);
                } else {
                    const availablePackages = buildOrder.map(name => {
                        const packageInfo = dependencyGraph.packages.get(name)!;
                        return `${path.basename(packageInfo.path)} (${name})`;
                    }).join(', ');

                    throw new Error(`Package directory '${startFrom}' not found. Available packages: ${availablePackages}`);
                }
            }

            // Find the start package in the build order and start execution from there
            const startIndex = buildOrder.findIndex(pkgName => pkgName === startPackageName);
            if (startIndex === -1) {
                throw new Error(`Package '${startFrom}' not found in build order. This should not happen.`);
            }

            // Filter build order to start from the specified package
            const originalLength = buildOrder.length;
            buildOrder = buildOrder.slice(startIndex);

            logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Starting execution from package '${startFrom}' (${buildOrder.length} of ${originalLength} packages remaining).`);
        }

        // Handle stop-at functionality if specified
        const stopAt = runConfig.tree?.stopAt;
        if (stopAt) {
            logger.verbose(`${isDryRun ? 'DRY RUN: ' : ''}Looking for stop package: ${stopAt}`);

            // Find the package that matches the stopAt directory name
            const stopIndex = buildOrder.findIndex(packageName => {
                const packageInfo = dependencyGraph.packages.get(packageName)!;
                const dirName = path.basename(packageInfo.path);
                return dirName === stopAt || packageName === stopAt;
            });

            if (stopIndex === -1) {
                // Check if the package exists but was excluded across all directories
                let allPackageJsonPathsForCheck: string[] = [];
                for (const targetDirectory of directories) {
                    const packageJsonPaths = await scanForPackageJsonFiles(targetDirectory, []); // No exclusions
                    allPackageJsonPathsForCheck = allPackageJsonPathsForCheck.concat(packageJsonPaths);
                }
                let wasExcluded = false;

                for (const packageJsonPath of allPackageJsonPathsForCheck) {
                    try {
                        const packageInfo = await parsePackageJson(packageJsonPath);
                        const dirName = path.basename(packageInfo.path);

                        if (dirName === stopAt || packageInfo.name === stopAt) {
                            // Check if this package was excluded
                            if (shouldExclude(packageJsonPath, excludedPatterns)) {
                                wasExcluded = true;
                                break;
                            }
                        }
                    } catch {
                        // Skip invalid package.json files
                        continue;
                    }
                }

                if (wasExcluded) {
                    const excludedPatternsStr = excludedPatterns.join(', ');
                    throw new Error(`Package directory '${stopAt}' was excluded by exclusion patterns: ${excludedPatternsStr}. Remove the exclusion pattern or choose a different stop package.`);
                } else {
                    const availablePackages = buildOrder.map(name => {
                        const packageInfo = dependencyGraph.packages.get(name)!;
                        return `${path.basename(packageInfo.path)} (${name})`;
                    }).join(', ');

                    throw new Error(`Package directory '${stopAt}' not found. Available packages: ${availablePackages}`);
                }
            }

            // Truncate the build order before the stop package (the stop package is not executed)
            const originalLength = buildOrder.length;
            buildOrder = buildOrder.slice(0, stopIndex);

            const stoppedCount = originalLength - stopIndex;
            if (stoppedCount > 0) {
                logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Stopping before '${stopAt}' - excluding ${stoppedCount} package${stoppedCount === 1 ? '' : 's'}`);
            }
        }

        // Helper function to determine version scope indicator
        const getVersionScopeIndicator = (versionRange: string): string => {
            // Remove whitespace and check the pattern
            const cleanRange = versionRange.trim();

            // Preserve the original prefix (^, ~, >=, etc.)
            const prefixMatch = cleanRange.match(/^([^0-9]*)/);
            const prefix = prefixMatch ? prefixMatch[1] : '';

            // Extract the version part after the prefix
            const versionPart = cleanRange.substring(prefix.length);

            // Count the number of dots to determine scope
            const dotCount = (versionPart.match(/\./g) || []).length;

            if (dotCount >= 2) {
                // Has patch version (e.g., "^4.4.32" -> "^P")
                return prefix + 'P';
            } else if (dotCount === 1) {
                // Has minor version only (e.g., "^4.4" -> "^m")
                return prefix + 'm';
            } else if (dotCount === 0 && versionPart.match(/^\d+$/)) {
                // Has major version only (e.g., "^4" -> "^M")
                return prefix + 'M';
            }

            // For complex ranges or non-standard formats, return as-is
            return cleanRange;
        };

        // Helper function to find packages that consume a given package
        const findConsumingPackagesForBranches = async (
            targetPackageName: string,
            allPackages: Map<string, PackageInfo>,
            storage: any
        ): Promise<string[]> => {
            const consumers: string[] = [];

            // Extract scope from target package name (e.g., "@fjell/eslint-config" -> "@fjell/")
            const targetScope = targetPackageName.includes('/') ? targetPackageName.split('/')[0] + '/' : null;

            for (const [packageName, packageInfo] of allPackages) {
                if (packageName === targetPackageName) continue;

                try {
                    const packageJsonPath = path.join(packageInfo.path, 'package.json');
                    const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
                    const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
                    const packageJson = validatePackageJson(parsed, packageJsonPath);

                    // Check if this package depends on the target package and get the version range
                    const dependencyTypes = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
                    let versionRange: string | null = null;

                    for (const depType of dependencyTypes) {
                        if (packageJson[depType] && packageJson[depType][targetPackageName]) {
                            versionRange = packageJson[depType][targetPackageName];
                            break;
                        }
                    }

                    if (versionRange) {
                        // Apply scope substitution for consumers in the same scope
                        let consumerDisplayName = packageName;
                        if (targetScope && packageName.startsWith(targetScope)) {
                            // Replace scope with "./" (e.g., "@fjell/core" -> "./core")
                            consumerDisplayName = './' + packageName.substring(targetScope.length);
                        }

                        // Add version scope indicator
                        const scopeIndicator = getVersionScopeIndicator(versionRange);
                        consumerDisplayName += ` (${scopeIndicator})`;

                        consumers.push(consumerDisplayName);
                    }
                } catch {
                    // Skip packages we can't parse
                    continue;
                }
            }

            return consumers.sort();
        };

        // Handle special "branches" command that displays table
        if (builtInCommand === 'branches') {
            logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Branch Status Summary:`);
            logger.info('');

            // Calculate column widths for nice formatting
            let maxNameLength = 'Package'.length;
            let maxBranchLength = 'Branch'.length;
            let maxVersionLength = 'Version'.length;
            let maxStatusLength = 'Status'.length;
            let maxLinkLength = 'Linked'.length;
            let maxConsumersLength = 'Consumers'.length;

            const branchInfos: Array<{
                name: string;
                branch: string;
                version: string;
                status: string;
                linked: string;
                consumers: string[];
            }> = [];

            // Create storage instance for consumer lookup
            const storage = createStorage();

            // Get globally linked packages once at the beginning
            const globallyLinkedPackages = await getGloballyLinkedPackages();

            // ANSI escape codes for progress display
            const ANSI = {
                CURSOR_UP: '\x1b[1A',
                CURSOR_TO_START: '\x1b[0G',
                CLEAR_LINE: '\x1b[2K',
                GREEN: '\x1b[32m',
                BLUE: '\x1b[34m',
                YELLOW: '\x1b[33m',
                RESET: '\x1b[0m',
                BOLD: '\x1b[1m'
            };

            // Check if terminal supports ANSI
            const supportsAnsi = process.stdout.isTTY &&
                                  process.env.TERM !== 'dumb' &&
                                  !process.env.NO_COLOR;

            const totalPackages = buildOrder.length;
            const concurrency = 5; // Process up to 5 packages at a time
            let completedCount = 0;
            let isFirstProgress = true;

            // Function to update progress display
            const updateProgress = (currentPackage: string, completed: number, total: number) => {
                if (!supportsAnsi) return;

                if (!isFirstProgress) {
                    // Move cursor up and clear the line
                    process.stdout.write(ANSI.CURSOR_UP + ANSI.CURSOR_TO_START + ANSI.CLEAR_LINE);
                }

                const percentage = Math.round((completed / total) * 100);
                const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
                const progress = `${ANSI.BLUE}${ANSI.BOLD}Analyzing packages... ${ANSI.GREEN}[${progressBar}] ${percentage}%${ANSI.RESET} ${ANSI.YELLOW}(${completed}/${total})${ANSI.RESET}`;
                const current = currentPackage ? ` - Currently: ${currentPackage}` : '';

                process.stdout.write(progress + current + '\n');
                isFirstProgress = false;
            };

            // Function to process a single package
            const processPackage = async (packageName: string): Promise<{
                name: string;
                branch: string;
                version: string;
                status: string;
                linked: string;
                consumers: string[];
            }> => {
                const packageInfo = dependencyGraph.packages.get(packageName)!;

                try {
                    // Process git status and consumers in parallel
                    const [gitStatus, consumers] = await Promise.all([
                        getGitStatusSummary(packageInfo.path),
                        findConsumingPackagesForBranches(packageName, dependencyGraph.packages, storage)
                    ]);

                    // Check if this package is globally linked (available to be linked to)
                    const isGloballyLinked = globallyLinkedPackages.has(packageName);
                    const linkedText = isGloballyLinked ? '✓' : '';

                    // Add asterisk to consumers that are actively linking to globally linked packages
                    // and check for link problems to highlight in red
                    const consumersWithLinkStatus = await Promise.all(consumers.map(async (consumer) => {
                        // Extract the base consumer name from the format "package-name (^P)" or "./scoped-name (^m)"
                        const baseConsumerName = consumer.replace(/ \([^)]+\)$/, ''); // Remove version scope indicator

                        // Get the original package name from display name (remove scope substitution)
                        const originalConsumerName = baseConsumerName.startsWith('./')
                            ? baseConsumerName.replace('./', packageName.split('/')[0] + '/')
                            : baseConsumerName;

                        // Find the consumer package info to get its path
                        const consumerPackageInfo = Array.from(dependencyGraph.packages.values())
                            .find(pkg => pkg.name === originalConsumerName);

                        if (consumerPackageInfo) {
                            const [consumerLinkedDeps, linkProblems] = await Promise.all([
                                getLinkedDependencies(consumerPackageInfo.path),
                                getLinkCompatibilityProblems(consumerPackageInfo.path, dependencyGraph.packages)
                            ]);

                            let consumerDisplay = consumer;

                            // Add asterisk if this consumer is actively linking to this package
                            if (consumerLinkedDeps.has(packageName)) {
                                consumerDisplay += '*';
                            }

                            // Check if this consumer has link problems with the current package
                            if (linkProblems.has(packageName)) {
                                // Highlight in red using ANSI escape codes (only if terminal supports it)
                                if (supportsAnsi) {
                                    consumerDisplay = `\x1b[31m${consumerDisplay}\x1b[0m`;
                                } else {
                                    // Fallback for terminals that don't support ANSI colors
                                    consumerDisplay += ' [LINK PROBLEM]';
                                }
                            }

                            return consumerDisplay;
                        }

                        return consumer;
                    }));

                    return {
                        name: packageName,
                        branch: gitStatus.branch,
                        version: packageInfo.version,
                        status: gitStatus.status,
                        linked: linkedText,
                        consumers: consumersWithLinkStatus
                    };
                } catch (error: any) {
                    logger.warn(`Failed to get git status for ${packageName}: ${error.message}`);
                    return {
                        name: packageName,
                        branch: 'error',
                        version: packageInfo.version,
                        status: 'error',
                        linked: '✗',
                        consumers: ['error']
                    };
                }
            };

            // Process packages in batches with progress updates
            updateProgress('Starting...', 0, totalPackages);

            for (let i = 0; i < buildOrder.length; i += concurrency) {
                const batch = buildOrder.slice(i, i + concurrency);

                // Update progress to show current batch
                const currentBatchStr = batch.length === 1 ? batch[0] : `${batch[0]} + ${batch.length - 1} others`;
                updateProgress(currentBatchStr, completedCount, totalPackages);

                // Process batch in parallel
                const batchResults = await Promise.all(
                    batch.map(packageName => processPackage(packageName))
                );

                // Add results and update column widths
                for (const result of batchResults) {
                    branchInfos.push(result);
                    maxNameLength = Math.max(maxNameLength, result.name.length);
                    maxBranchLength = Math.max(maxBranchLength, result.branch.length);
                    maxVersionLength = Math.max(maxVersionLength, result.version.length);
                    maxStatusLength = Math.max(maxStatusLength, result.status.length);
                    maxLinkLength = Math.max(maxLinkLength, result.linked.length);

                    // For consumers, calculate the width based on the longest consumer name
                    const maxConsumerLength = result.consumers.length > 0
                        ? Math.max(...result.consumers.map(c => c.length))
                        : 0;
                    maxConsumersLength = Math.max(maxConsumersLength, maxConsumerLength);
                }

                completedCount += batch.length;
                updateProgress('', completedCount, totalPackages);
            }

            // Clear progress line and add spacing
            if (supportsAnsi && !isFirstProgress) {
                process.stdout.write(ANSI.CURSOR_UP + ANSI.CURSOR_TO_START + ANSI.CLEAR_LINE);
            }
            logger.info(`${ANSI.GREEN}✅ Analysis complete!${ANSI.RESET} Processed ${totalPackages} packages in batches of ${concurrency}.`);
            logger.info('');

            // Print header (new order: Package | Branch | Version | Status | Linked | Consumers)
            const nameHeader = 'Package'.padEnd(maxNameLength);
            const branchHeader = 'Branch'.padEnd(maxBranchLength);
            const versionHeader = 'Version'.padEnd(maxVersionLength);
            const statusHeader = 'Status'.padEnd(maxStatusLength);
            const linkHeader = 'Linked'.padEnd(maxLinkLength);
            const consumersHeader = 'Consumers';

            logger.info(`${nameHeader} | ${branchHeader} | ${versionHeader} | ${statusHeader} | ${linkHeader} | ${consumersHeader}`);
            logger.info(`${'-'.repeat(maxNameLength)} | ${'-'.repeat(maxBranchLength)} | ${'-'.repeat(maxVersionLength)} | ${'-'.repeat(maxStatusLength)} | ${'-'.repeat(maxLinkLength)} | ${'-'.repeat(9)}`);

            // Print data rows with multi-line consumers
            for (const info of branchInfos) {
                const nameCol = info.name.padEnd(maxNameLength);
                const branchCol = info.branch.padEnd(maxBranchLength);
                const versionCol = info.version.padEnd(maxVersionLength);
                const statusCol = info.status.padEnd(maxStatusLength);
                const linkCol = info.linked.padEnd(maxLinkLength);

                if (info.consumers.length === 0) {
                    // No consumers - single line
                    logger.info(`${nameCol} | ${branchCol} | ${versionCol} | ${statusCol} | ${linkCol} | `);
                } else if (info.consumers.length === 1) {
                    // Single consumer - single line
                    logger.info(`${nameCol} | ${branchCol} | ${versionCol} | ${statusCol} | ${linkCol} | ${info.consumers[0]}`);
                } else {
                    // Multiple consumers - first consumer on same line, rest on new lines with continuous column separators
                    logger.info(`${nameCol} | ${branchCol} | ${versionCol} | ${statusCol} | ${linkCol} | ${info.consumers[0]}`);

                    // Additional consumers on separate lines with proper column separators
                    const emptyNameCol = ' '.repeat(maxNameLength);
                    const emptyBranchCol = ' '.repeat(maxBranchLength);
                    const emptyVersionCol = ' '.repeat(maxVersionLength);
                    const emptyStatusCol = ' '.repeat(maxStatusLength);
                    const emptyLinkCol = ' '.repeat(maxLinkLength);

                    for (let i = 1; i < info.consumers.length; i++) {
                        logger.info(`${emptyNameCol} | ${emptyBranchCol} | ${emptyVersionCol} | ${emptyStatusCol} | ${emptyLinkCol} | ${info.consumers[i]}`);
                    }
                }
            }

            logger.info('');
            // Add legend explaining the symbols and colors
            logger.info('Legend:');
            logger.info('  * = Consumer is actively linking to this package');
            logger.info('  (^P) = Patch-level dependency (e.g., "^4.4.32")');
            logger.info('  (^m) = Minor-level dependency (e.g., "^4.4")');
            logger.info('  (^M) = Major-level dependency (e.g., "^4")');
            logger.info('  (~P), (>=M), etc. = Other version prefixes preserved');
            if (supportsAnsi) {
                logger.info('  \x1b[31mRed text\x1b[0m = Consumer has link problems (version mismatches) with this package');
            } else {
                logger.info('  [LINK PROBLEM] = Consumer has link problems (version mismatches) with this package');
            }
            logger.info('');
            return `Branch status summary for ${branchInfos.length} packages completed.`;
        }

        // Handle special "checkout" command that switches all packages to specified branch
        if (builtInCommand === 'checkout') {
            const targetBranch = runConfig.tree?.packageArgument;
            if (!targetBranch) {
                throw new Error('checkout subcommand requires a branch name. Usage: kodrdriv tree checkout <branch-name>');
            }

            logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Workspace Checkout to Branch: ${targetBranch}`);
            logger.info('');

            // Phase 1: Safety check - scan all packages for uncommitted changes
            logger.info('🔍 Phase 1: Checking for uncommitted changes across workspace...');
            const packagesWithChanges: Array<{
                name: string;
                path: string;
                status: string;
                hasUncommittedChanges: boolean;
                hasUnstagedFiles: boolean;
            }> = [];

            for (const packageName of buildOrder) {
                const packageInfo = dependencyGraph.packages.get(packageName)!;

                try {
                    const gitStatus = await getGitStatusSummary(packageInfo.path);
                    const hasProblems = gitStatus.hasUncommittedChanges || gitStatus.hasUnstagedFiles;

                    packagesWithChanges.push({
                        name: packageName,
                        path: packageInfo.path,
                        status: gitStatus.status,
                        hasUncommittedChanges: gitStatus.hasUncommittedChanges,
                        hasUnstagedFiles: gitStatus.hasUnstagedFiles
                    });

                    if (hasProblems) {
                        logger.warn(`⚠️  ${packageName}: ${gitStatus.status}`);
                    } else {
                        logger.verbose(`✅ ${packageName}: clean`);
                    }
                } catch (error: any) {
                    logger.warn(`❌ ${packageName}: error checking status - ${error.message}`);
                    packagesWithChanges.push({
                        name: packageName,
                        path: packageInfo.path,
                        status: 'error',
                        hasUncommittedChanges: false,
                        hasUnstagedFiles: false
                    });
                }
            }

            // Check if any packages have uncommitted changes
            const problemPackages = packagesWithChanges.filter(pkg =>
                pkg.hasUncommittedChanges || pkg.hasUnstagedFiles || pkg.status === 'error'
            );

            if (problemPackages.length > 0) {
                logger.error(`❌ Cannot proceed with checkout: ${problemPackages.length} packages have uncommitted changes or errors:`);
                logger.error('');

                for (const pkg of problemPackages) {
                    logger.error(`  📦 ${pkg.name} (${pkg.path}):`);
                    logger.error(`      Status: ${pkg.status}`);
                }

                logger.error('');
                logger.error('🔧 To resolve this issue:');
                logger.error('   1. Commit or stash changes in the packages listed above');
                logger.error('   2. Or use "kodrdriv tree commit" to commit changes across all packages');
                logger.error('   3. Then re-run the checkout command');
                logger.error('');

                throw new Error(`Workspace checkout blocked: ${problemPackages.length} packages have uncommitted changes`);
            }

            logger.info(`✅ Phase 1 complete: All ${packagesWithChanges.length} packages are clean`);
            logger.info('');

            // Phase 2: Perform the checkout
            logger.info(`🔄 Phase 2: Checking out all packages to branch '${targetBranch}'...`);

            let successCount = 0;
            const failedPackages: Array<{ name: string; error: string }> = [];

            for (let i = 0; i < buildOrder.length; i++) {
                const packageName = buildOrder[i];
                const packageInfo = dependencyGraph.packages.get(packageName)!;

                if (isDryRun) {
                    logger.info(`[${i + 1}/${buildOrder.length}] ${packageName}: Would checkout ${targetBranch}`);
                    successCount++;
                } else {
                    try {
                        const originalCwd = process.cwd();
                        process.chdir(packageInfo.path);

                        try {
                            // Check if target branch exists locally
                            let branchExists = false;
                            try {
                                await runSecure('git', ['rev-parse', '--verify', targetBranch]);
                                branchExists = true;
                            } catch {
                                // Branch doesn't exist locally
                                branchExists = false;
                            }

                            if (branchExists) {
                                await runSecure('git', ['checkout', targetBranch]);
                                logger.info(`[${i + 1}/${buildOrder.length}] ${packageName}: ✅ Checked out ${targetBranch}`);
                            } else {
                                // Try to check out branch from remote
                                try {
                                    await runSecure('git', ['checkout', '-b', targetBranch, `origin/${targetBranch}`]);
                                    logger.info(`[${i + 1}/${buildOrder.length}] ${packageName}: ✅ Checked out ${targetBranch} from origin`);
                                } catch {
                                    // If that fails, create a new branch
                                    await runSecure('git', ['checkout', '-b', targetBranch]);
                                    logger.info(`[${i + 1}/${buildOrder.length}] ${packageName}: ✅ Created new branch ${targetBranch}`);
                                }
                            }

                            successCount++;
                        } finally {
                            process.chdir(originalCwd);
                        }
                    } catch (error: any) {
                        logger.error(`[${i + 1}/${buildOrder.length}] ${packageName}: ❌ Failed - ${error.message}`);
                        failedPackages.push({ name: packageName, error: error.message });
                    }
                }
            }

            // Report results
            if (failedPackages.length > 0) {
                logger.error(`❌ Checkout completed with errors: ${successCount}/${buildOrder.length} packages successful`);
                logger.error('');
                logger.error('Failed packages:');
                for (const failed of failedPackages) {
                    logger.error(`  - ${failed.name}: ${failed.error}`);
                }
                throw new Error(`Checkout failed for ${failedPackages.length} packages`);
            } else {
                logger.info(`✅ Checkout complete: All ${buildOrder.length} packages successfully checked out to '${targetBranch}'`);
                return `Workspace checkout complete: ${successCount} packages checked out to '${targetBranch}'`;
            }
        }

        // Display results
        logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Build order determined:`);

        let returnOutput = '';

        if (runConfig.verbose || runConfig.debug) {
            // Verbose mode: Skip simple format, show detailed format before command execution
            logger.info(''); // Add spacing
            const rangeInfo = [];
            if (startFrom) rangeInfo.push(`starting from ${startFrom}`);
            if (stopAt) rangeInfo.push(`stopping before ${stopAt}`);
            const rangeStr = rangeInfo.length > 0 ? ` (${rangeInfo.join(', ')})` : '';
            logger.info(`Detailed Build Order for ${buildOrder.length} packages${rangeStr}:`);
            logger.info('==========================================');

            buildOrder.forEach((packageName, index) => {
                const packageInfo = dependencyGraph.packages.get(packageName)!;
                const localDeps = Array.from(packageInfo.localDependencies);

                logger.info(`${index + 1}. ${packageName} (${packageInfo.version})`);
                logger.info(`   Path: ${packageInfo.path}`);

                if (localDeps.length > 0) {
                    logger.info(`   Local Dependencies: ${localDeps.join(', ')}`);
                } else {
                    logger.info(`   Local Dependencies: none`);
                }
                logger.info(''); // Add spacing between packages
            });

            // Simple return output for verbose mode (no need to repeat detailed info)
            returnOutput = `\nBuild order: ${buildOrder.join(' → ')}\n`;
        } else {
            // Non-verbose mode: Show simple build order
            buildOrder.forEach((packageName, index) => {
                const packageInfo = dependencyGraph.packages.get(packageName)!;
                const localDeps = Array.from(packageInfo.localDependencies);

                // Log each step
                if (localDeps.length > 0) {
                    logger.info(`${index + 1}. ${packageName} (depends on: ${localDeps.join(', ')})`);
                } else {
                    logger.info(`${index + 1}. ${packageName} (no local dependencies)`);
                }
            });

            // Simple return output for non-verbose mode
            returnOutput = `\nBuild order: ${buildOrder.join(' → ')}\n`;
        }

        // Execute command if provided (custom command or built-in command)
        const cmd = runConfig.tree?.cmd;

        // Determine command to execute
        let commandToRun: string | undefined;
        let isBuiltInCommand = false;

        if (builtInCommand) {
            // Built-in command mode: shell out to kodrdriv subprocess
            // Build command with propagated global options
            const globalOptions: string[] = [];

            // Propagate global flags that should be inherited by subprocesses
            if (runConfig.debug) globalOptions.push('--debug');
            if (runConfig.verbose) globalOptions.push('--verbose');
            if (runConfig.dryRun) globalOptions.push('--dry-run');
            if (runConfig.overrides) globalOptions.push('--overrides');

            // Propagate global options with values
            if (runConfig.model) globalOptions.push(`--model "${runConfig.model}"`);
            if (runConfig.configDirectory) globalOptions.push(`--config-dir "${runConfig.configDirectory}"`);
            if (runConfig.outputDirectory) globalOptions.push(`--output-dir "${runConfig.outputDirectory}"`);
            if (runConfig.preferencesDirectory) globalOptions.push(`--preferences-dir "${runConfig.preferencesDirectory}"`);

            // Build the command with global options
            const optionsString = globalOptions.length > 0 ? ` ${globalOptions.join(' ')}` : '';

            // Add package argument for link/unlink/updates commands
            const packageArg = runConfig.tree?.packageArgument;
            const packageArgString = (packageArg && (builtInCommand === 'link' || builtInCommand === 'unlink' || builtInCommand === 'updates'))
                ? ` "${packageArg}"`
                : '';

            // Add command-specific options
            let commandSpecificOptions = '';

            // Commit command options
            if (builtInCommand === 'commit') {
                if (runConfig.commit?.selfReflection) {
                    commandSpecificOptions += ' --self-reflection';
                }
                if (runConfig.commit?.add) {
                    commandSpecificOptions += ' --add';
                }
                if (runConfig.commit?.cached) {
                    commandSpecificOptions += ' --cached';
                }
                if (runConfig.commit?.interactive) {
                    commandSpecificOptions += ' --interactive';
                }
                if (runConfig.commit?.amend) {
                    commandSpecificOptions += ' --amend';
                }
                if (runConfig.commit?.skipFileCheck) {
                    commandSpecificOptions += ' --skip-file-check';
                }
                if (runConfig.commit?.maxAgenticIterations) {
                    commandSpecificOptions += ` --max-agentic-iterations ${runConfig.commit.maxAgenticIterations}`;
                }
                if (runConfig.commit?.allowCommitSplitting) {
                    commandSpecificOptions += ' --allow-commit-splitting';
                }
                if (runConfig.commit?.messageLimit) {
                    commandSpecificOptions += ` --message-limit ${runConfig.commit.messageLimit}`;
                }
                if (runConfig.commit?.maxDiffBytes) {
                    commandSpecificOptions += ` --max-diff-bytes ${runConfig.commit.maxDiffBytes}`;
                }
                if (runConfig.commit?.direction) {
                    commandSpecificOptions += ` --direction "${runConfig.commit.direction}"`;
                }
                if (runConfig.commit?.context) {
                    commandSpecificOptions += ` --context "${runConfig.commit.context}"`;
                }
                if (runConfig.commit?.contextFiles && runConfig.commit.contextFiles.length > 0) {
                    commandSpecificOptions += ` --context-files ${runConfig.commit.contextFiles.join(' ')}`;
                }
                // Push option can be boolean or string (remote name)
                if (runConfig.commit?.push) {
                    if (typeof runConfig.commit.push === 'string') {
                        commandSpecificOptions += ` --push "${runConfig.commit.push}"`;
                    } else {
                        commandSpecificOptions += ' --push';
                    }
                }
                // Model-specific options for commit
                if (runConfig.commit?.model) {
                    commandSpecificOptions += ` --model "${runConfig.commit.model}"`;
                }
                if (runConfig.commit?.openaiReasoning) {
                    commandSpecificOptions += ` --openai-reasoning ${runConfig.commit.openaiReasoning}`;
                }
                if (runConfig.commit?.openaiMaxOutputTokens) {
                    commandSpecificOptions += ` --openai-max-output-tokens ${runConfig.commit.openaiMaxOutputTokens}`;
                }
            }

            // Release command options (only for direct 'release' command)
            if (builtInCommand === 'release') {
                if (runConfig.release?.selfReflection) {
                    commandSpecificOptions += ' --self-reflection';
                }
                if (runConfig.release?.maxAgenticIterations) {
                    commandSpecificOptions += ` --max-agentic-iterations ${runConfig.release.maxAgenticIterations}`;
                }
                if (runConfig.release?.interactive) {
                    commandSpecificOptions += ' --interactive';
                }
                if (runConfig.release?.from) {
                    commandSpecificOptions += ` --from "${runConfig.release.from}"`;
                }
                if (runConfig.release?.to) {
                    commandSpecificOptions += ` --to "${runConfig.release.to}"`;
                }
                if (runConfig.release?.focus) {
                    commandSpecificOptions += ` --focus "${runConfig.release.focus}"`;
                }
                if (runConfig.release?.context) {
                    commandSpecificOptions += ` --context "${runConfig.release.context}"`;
                }
                if (runConfig.release?.contextFiles && runConfig.release.contextFiles.length > 0) {
                    commandSpecificOptions += ` --context-files ${runConfig.release.contextFiles.join(' ')}`;
                }
                if (runConfig.release?.messageLimit) {
                    commandSpecificOptions += ` --message-limit ${runConfig.release.messageLimit}`;
                }
                if (runConfig.release?.maxDiffBytes) {
                    commandSpecificOptions += ` --max-diff-bytes ${runConfig.release.maxDiffBytes}`;
                }
                if (runConfig.release?.noMilestones) {
                    commandSpecificOptions += ' --no-milestones';
                }
                if (runConfig.release?.fromMain) {
                    commandSpecificOptions += ' --from-main';
                }
                // Model-specific options for release
                if (runConfig.release?.model) {
                    commandSpecificOptions += ` --model "${runConfig.release.model}"`;
                }
                if (runConfig.release?.openaiReasoning) {
                    commandSpecificOptions += ` --openai-reasoning ${runConfig.release.openaiReasoning}`;
                }
                if (runConfig.release?.openaiMaxOutputTokens) {
                    commandSpecificOptions += ` --openai-max-output-tokens ${runConfig.release.openaiMaxOutputTokens}`;
                }
            }

            // Publish command options (pass self-reflection - publish reads other release config from config file)
            if (builtInCommand === 'publish') {
                commandSpecificOptions += ' --skip-link-cleanup';
                if (runConfig.release?.selfReflection) {
                    commandSpecificOptions += ' --self-reflection';
                }
                if (runConfig.release?.maxAgenticIterations) {
                    commandSpecificOptions += ` --max-agentic-iterations ${runConfig.release.maxAgenticIterations}`;
                }
                // Publish has its own --from, --interactive, --from-main flags (not from release config)
            }

            // Unlink command options
            if (builtInCommand === 'unlink' && runConfig.tree?.cleanNodeModules) {
                commandSpecificOptions += ' --clean-node-modules';
            }

            // Link/Unlink externals
            if ((builtInCommand === 'link' || builtInCommand === 'unlink') && runConfig.tree?.externals && runConfig.tree.externals.length > 0) {
                commandSpecificOptions += ` --externals ${runConfig.tree.externals.join(' ')}`;
            }

            commandToRun = `kodrdriv ${builtInCommand}${optionsString}${packageArgString}${commandSpecificOptions}`;
            isBuiltInCommand = true;
        } else if (cmd) {
            // Custom command mode
            commandToRun = cmd;
        }

        if (commandToRun) {
            // Validate scripts for run command before execution
            const scriptsToValidate = (runConfig as any).__scriptsToValidate;
            if (scriptsToValidate && scriptsToValidate.length > 0) {
                logger.info(`🔍 Validating scripts before execution: ${scriptsToValidate.join(', ')}`);
                const validation = await validateScripts(dependencyGraph.packages, scriptsToValidate);

                if (!validation.valid) {
                    logger.error('');
                    logger.error('❌ Script validation failed. Cannot proceed with execution.');
                    logger.error('');
                    logger.error('💡 To fix this:');
                    logger.error('   1. Add the missing scripts to the package.json files');
                    logger.error('   2. Or exclude packages that don\'t need these scripts using --exclude');
                    logger.error('   3. Or run individual packages that have the required scripts');
                    logger.error('');
                    throw new Error('Script validation failed. See details above.');
                }
            }

            // Validate precommit script exists in all packages for precommit built-in command
            if (builtInCommand === 'precommit') {
                logger.info('🔍 Validating all packages have a "precommit" script...');
                const validation = await validateScripts(dependencyGraph.packages, ['precommit']);

                if (!validation.valid) {
                    logger.error('');
                    logger.error('❌ Precommit validation failed. The following packages are missing a "precommit" script:');
                    logger.error('');
                    for (const [packageName] of validation.missingScripts) {
                        logger.error(`   - ${packageName}`);
                    }
                    logger.error('');
                    logger.error('💡 To fix this, add a "precommit" script to each package.json, for example:');
                    logger.error('   "scripts": {');
                    logger.error('     "precommit": "npm run clean && npm run build && npm run lint && npm run test"');
                    logger.error('   }');
                    logger.error('');
                    throw new Error('Precommit validation failed. All packages must have a "precommit" script.');
                }
                logger.info('✅ All packages have a "precommit" script');
            }

            // Validate command for parallel execution if parallel mode is enabled
            if (runConfig.tree?.parallel) {
                const { CommandValidator } = await import('@eldrforge/tree-execution');
                const validation = CommandValidator.validateForParallel(commandToRun, builtInCommand);

                CommandValidator.logValidation(validation);

                if (!validation.valid) {
                    logger.error('');
                    logger.error('Cannot proceed with parallel execution due to validation errors.');
                    logger.error('Run without --parallel flag to execute sequentially.');
                    throw new Error('Command validation failed for parallel execution');
                }

                // Apply recommended concurrency if not explicitly set
                if (!runConfig.tree.maxConcurrency) {
                    const os = await import('os');
                    const recommended = CommandValidator.getRecommendedConcurrency(
                        builtInCommand,
                        os.cpus().length,
                        commandToRun
                    );

                    if (recommended !== os.cpus().length) {
                        const reason = builtInCommand ? builtInCommand : `custom command "${commandToRun}"`;
                        logger.info(`💡 Using recommended concurrency for ${reason}: ${recommended}`);
                        runConfig.tree.maxConcurrency = recommended;
                    }
                }
            }

            // Create set of all package names for inter-project dependency detection
            const allPackageNames = new Set(Array.from(dependencyGraph.packages.keys()));

            // Initialize execution context if not continuing
            if (!executionContext) {
                executionContext = {
                    command: commandToRun,
                    originalConfig: runConfig,
                    publishedVersions: [],
                    completedPackages: [],
                    buildOrder: buildOrder,
                    startTime: new Date(),
                    lastUpdateTime: new Date()
                };

                // Save initial context for commands that support continuation
                if (isBuiltInCommand && (builtInCommand === 'publish' || builtInCommand === 'run') && !isDryRun) {
                    await saveExecutionContext(executionContext, runConfig.outputDirectory);
                }
            }

            // Add spacing before command execution
            logger.info('');
            const executionDescription = isBuiltInCommand ? `built-in command "${builtInCommand}"` : `"${commandToRun}"`;
            logger.info(`${isDryRun ? 'DRY RUN: ' : ''}Executing ${executionDescription} in ${buildOrder.length} packages...`);

            // Add detailed multi-project execution context for debug mode
            if (runConfig.debug) {
                logger.debug('MULTI_PROJECT_PLAN: Execution plan initialized | Total Packages: %d | Command: %s | Built-in: %s | Dry Run: %s | Parallel: %s',
                    buildOrder.length, commandToRun, isBuiltInCommand, isDryRun, runConfig.tree?.parallel || false);

                // Log package execution order with dependencies
                logger.debug('MULTI_PROJECT_ORDER: Package execution sequence:');
                buildOrder.forEach((pkgName, idx) => {
                    const pkgInfo = dependencyGraph.packages.get(pkgName);
                    if (pkgInfo) {
                        const deps = Array.isArray(pkgInfo.dependencies) ? pkgInfo.dependencies : [];
                        const depStr = deps.length > 0
                            ? ` | Dependencies: [${deps.join(', ')}]`
                            : ' | Dependencies: none';
                        logger.debug('  %d. %s%s', idx + 1, pkgName, depStr);
                    }
                });

                // Log dependency levels for parallel execution understanding
                const levels = new Map<string, number>();
                const calculateLevels = (pkg: string, visited = new Set<string>()): number => {
                    if (levels.has(pkg)) return levels.get(pkg)!;
                    if (visited.has(pkg)) return 0; // Circular dependency

                    visited.add(pkg);
                    const pkgInfo = dependencyGraph.packages.get(pkg);
                    const deps = Array.isArray(pkgInfo?.dependencies) ? pkgInfo.dependencies : [];
                    if (!pkgInfo || deps.length === 0) {
                        levels.set(pkg, 0);
                        return 0;
                    }

                    const maxDepLevel = Math.max(...deps.map((dep: string) => calculateLevels(dep, new Set(visited))));
                    const level = maxDepLevel + 1;
                    levels.set(pkg, level);
                    return level;
                };

                buildOrder.forEach(pkg => calculateLevels(pkg));
                const maxLevel = Math.max(...Array.from(levels.values()));

                logger.debug('MULTI_PROJECT_LEVELS: Dependency depth analysis | Max Depth: %d levels', maxLevel + 1);
                for (let level = 0; level <= maxLevel; level++) {
                    const packagesAtLevel = buildOrder.filter(pkg => levels.get(pkg) === level);
                    logger.debug('  Level %d (%d packages): %s', level, packagesAtLevel.length, packagesAtLevel.join(', '));
                }

                if (runConfig.tree?.parallel) {
                    const os = await import('os');
                    const concurrency = runConfig.tree.maxConcurrency || os.cpus().length;
                    logger.debug('MULTI_PROJECT_PARALLEL: Parallel execution configuration | Max Concurrency: %d | Retry Attempts: %d',
                        concurrency, runConfig.tree.retry?.maxAttempts || 3);
                }

                if (isContinue) {
                    const completed = executionContext?.completedPackages.length || 0;
                    logger.debug('MULTI_PROJECT_RESUME: Continuing previous execution | Completed: %d | Remaining: %d',
                        completed, buildOrder.length - completed);
                }
            }

            // Show info for publish commands
            if (isBuiltInCommand && builtInCommand === 'publish') {
                logger.info('Inter-project dependencies will be automatically updated before each publish.');
            }

            let successCount = 0;
            let failedPackage: string | null = null;

            // If continuing, start from where we left off
            const startIndex = isContinue && executionContext ? executionContext.completedPackages.length : 0;

            // Check if parallel execution is enabled
            if (runConfig.tree?.parallel) {
                logger.info('🚀 Using parallel execution mode');

                // If dry run, show preview instead of executing
                if (isDryRun) {
                    const preview = await generateDryRunPreview(
                        dependencyGraph,
                        buildOrder,
                        commandToRun!,
                        runConfig
                    );
                    return preview;
                }

                // Import parallel execution components
                const { TreeExecutionAdapter, createParallelProgressLogger, formatParallelResult } = await import('@eldrforge/tree-execution');
                const os = await import('os');

                // Create task pool
                const adapter = new TreeExecutionAdapter(
                    {
                        graph: dependencyGraph,
                        maxConcurrency: runConfig.tree.maxConcurrency || os.cpus().length,
                        command: commandToRun!,
                        config: runConfig,
                        checkpointPath: runConfig.outputDirectory,
                        continue: isContinue,
                        maxRetries: runConfig.tree.retry?.maxAttempts || 3,
                        initialRetryDelay: runConfig.tree.retry?.initialDelayMs || 5000,
                        maxRetryDelay: runConfig.tree.retry?.maxDelayMs || 60000,
                        backoffMultiplier: runConfig.tree.retry?.backoffMultiplier || 2
                    },
                    executePackage as any
                );

                // Set up progress logging
                createParallelProgressLogger(adapter.getPool(), runConfig);

                // Execute
                const result = await adapter.execute();

                // Format and return result
                const formattedResult = formatParallelResult(result);
                return formattedResult;
            }

            // Sequential execution
            const executionStartTime = Date.now();
            for (let i = startIndex; i < buildOrder.length; i++) {
                const packageName = buildOrder[i];

                // Skip if already completed (in continue mode)
                if (executionContext && executionContext.completedPackages.includes(packageName)) {
                    successCount++;
                    continue;
                }

                const packageInfo = dependencyGraph.packages.get(packageName)!;
                const packageLogger = createPackageLogger(packageName, i + 1, buildOrder.length, isDryRun);

                const result = await executePackage(
                    packageName,
                    packageInfo,
                    commandToRun!,
                    runConfig,
                    isDryRun,
                    i,
                    buildOrder.length,
                    allPackageNames,
                    isBuiltInCommand
                );

                if (result.success) {
                    successCount++;

                    // Update context
                    if (executionContext && isBuiltInCommand && (builtInCommand === 'publish' || builtInCommand === 'run') && !isDryRun) {
                        executionContext.completedPackages.push(packageName);
                        executionContext.publishedVersions = publishedVersions;
                        executionContext.lastUpdateTime = new Date();
                        await saveExecutionContext(executionContext, runConfig.outputDirectory);
                    }

                    // Add spacing between packages (except after the last one)
                    if (i < buildOrder.length - 1) {
                        logger.info('');
                        logger.info('');
                    }
                } else {
                    failedPackage = packageName;
                    const formattedError = formatSubprojectError(packageName, result.error, packageInfo, i + 1, buildOrder.length);

                    if (!isDryRun) {
                        packageLogger.error(`Execution failed`);
                        logger.error(formattedError);
                        logger.error(`Failed after ${successCount} successful packages.`);

                        // Special handling for timeout errors
                        if (result.isTimeoutError) {
                            logger.error('');
                            logger.error('⏰ TIMEOUT DETECTED: This appears to be a timeout error.');
                            logger.error('   This commonly happens when PR checks take longer than expected.');
                            logger.error('   The execution context has been saved for recovery.');
                            logger.error('');

                            // Save context even on timeout for recovery
                            if (executionContext && isBuiltInCommand && (builtInCommand === 'publish' || builtInCommand === 'run')) {
                                executionContext.completedPackages.push(packageName);
                                executionContext.publishedVersions = publishedVersions;
                                executionContext.lastUpdateTime = new Date();
                                await saveExecutionContext(executionContext, runConfig.outputDirectory);
                                logger.info('💾 Execution context saved for recovery.');
                            }

                            // For publish commands, provide specific guidance about CI/CD setup
                            if (builtInCommand === 'publish') {
                                logger.error('');
                                logger.error('💡 PUBLISH TIMEOUT TROUBLESHOOTING:');
                                logger.error('   This project may not have CI/CD workflows configured.');
                                logger.error('   Common solutions:');
                                logger.error('   1. Set up GitHub Actions workflows for this repository');
                                logger.error('   2. Use --sendit flag to skip user confirmation:');
                                logger.error(`      kodrdriv tree publish --sendit`);
                                logger.error('   3. Or manually promote this package:');
                                logger.error(`      kodrdriv tree publish --promote ${packageName}`);
                                logger.error('');
                            }
                        }

                        logger.error(`To resume from this point, run:`);
                        if (isBuiltInCommand) {
                            logger.error(`    kodrdriv tree ${builtInCommand} --continue`);
                        } else {
                            logger.error(`    kodrdriv tree --continue --cmd "${commandToRun}"`);
                        }

                        // For timeout errors, provide additional recovery instructions
                        if (result.isTimeoutError) {
                            logger.error('');
                            logger.error('🔧 RECOVERY OPTIONS:');
                            if (builtInCommand === 'publish') {
                                logger.error('   1. Wait for the PR checks to complete, then run:');
                                logger.error(`      cd ${packageInfo.path}`);
                                logger.error(`      kodrdriv publish`);
                                logger.error('   2. After the individual publish completes, run:');
                                logger.error(`      kodrdriv tree ${builtInCommand} --continue`);
                            } else {
                                logger.error('   1. Fix any issues in the package, then run:');
                                logger.error(`      cd ${packageInfo.path}`);
                                logger.error(`      ${commandToRun}`);
                                logger.error('   2. After the command completes successfully, run:');
                                logger.error(`      kodrdriv tree ${builtInCommand} --continue`);
                            }
                            logger.error('   3. Or promote this package to completed status:');
                            logger.error(`      kodrdriv tree ${builtInCommand} --promote ${packageName}`);
                            logger.error('   4. Or manually edit .kodrdriv-context to mark this package as completed');
                        }

                        // Add clear error summary at the very end
                        logger.error('');
                        logger.error('📋 ERROR SUMMARY:');
                        logger.error(`   Project that failed: ${packageName}`);
                        logger.error(`   Location: ${packageInfo.path}`);
                        logger.error(`   Position in tree: ${i + 1} of ${buildOrder.length} packages`);
                        logger.error(`   What failed: ${result.error?.message || 'Unknown error'}`);
                        logger.error('');

                        throw new Error(`Command failed in package ${packageName}`);
                    }
                    break;
                }
            }

            if (!failedPackage) {
                const totalExecutionTime = Date.now() - executionStartTime;
                const totalSeconds = (totalExecutionTime / 1000).toFixed(1);
                const totalMinutes = (totalExecutionTime / 60000).toFixed(1);
                const timeDisplay = totalExecutionTime < 60000
                    ? `${totalSeconds}s`
                    : `${totalMinutes}min (${totalSeconds}s)`;

                logger.info('');
                logger.info('═══════════════════════════════════════════════════════════');
                const summary = `${isDryRun ? 'DRY RUN: ' : ''}All ${buildOrder.length} packages completed successfully! 🎉`;
                logger.info(summary);
                logger.info(`⏱️  Total execution time: ${timeDisplay}`);
                logger.info(`📦 Packages processed: ${successCount}/${buildOrder.length}`);
                logger.info('═══════════════════════════════════════════════════════════');
                logger.info('');

                // Clean up context on successful completion
                if (isBuiltInCommand && (builtInCommand === 'publish' || builtInCommand === 'run') && !isDryRun) {
                    await cleanupContext(runConfig.outputDirectory);
                }

                return returnOutput; // Don't duplicate the summary in return string
            }
        }

        return returnOutput;

    } catch (error: any) {
        const errorMessage = `Failed to analyze workspace: ${error.message}`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
    } finally {
        // Intentionally preserve the mutex across executions to support multiple runs in the same process (e.g., test suite)
        // Do not destroy here; the process lifecycle will clean up resources.
    }
};
