import { getDryRunLogger, getLogger, Config } from '@eldrforge/core';
import { createStorage } from '@eldrforge/shared';
import { run, runSecure, safeJsonParse, validatePackageJson } from '@eldrforge/git-tools';
import { findAllPackageJsonFiles } from '@eldrforge/commands-git';
import fs from 'fs/promises';
import path from 'path';

// Helper function to check if a dependency matches any external unlink patterns
export const matchesExternalUnlinkPattern = (dependencyName: string, externalUnlinkPatterns: string[]): boolean => {
    if (!externalUnlinkPatterns || externalUnlinkPatterns.length === 0) {
        return false;
    }

    return externalUnlinkPatterns.some(pattern => {
        // Simple string matching - could be enhanced with glob patterns later
        return dependencyName === pattern || dependencyName.startsWith(pattern);
    });
};

// Helper function to check if a path is a symbolic link
export const isSymbolicLink = async (filePath: string): Promise<boolean> => {
    try {
        const stats = await fs.lstat(filePath);
        return stats.isSymbolicLink();
    } catch {
        return false;
    }
};

// Helper function to get the target of a symbolic link
export const getSymbolicLinkTarget = async (filePath: string): Promise<string | null> => {
    try {
        const target = await fs.readlink(filePath);
        return target;
    } catch {
        return null;
    }
};

// Helper function to find all linked dependencies in a package
export const findLinkedDependencies = async (
    packagePath: string,
    packageName: string,
    storage: any,
    logger: any
): Promise<Array<{ dependencyName: string; targetPath: string; isExternal: boolean }>> => {
    const linkedDependencies: Array<{ dependencyName: string; targetPath: string; isExternal: boolean }> = [];

    try {
        const packageJsonPath = path.join(packagePath, 'package.json');
        const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
        const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
        const packageJson = validatePackageJson(parsed, packageJsonPath);

        const allDependencies = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        };

        const nodeModulesPath = path.join(packagePath, 'node_modules');

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [dependencyName, version] of Object.entries(allDependencies)) {
            let dependencyPath: string;

            if (dependencyName.startsWith('@')) {
                // Scoped package
                const [scope, name] = dependencyName.split('/');
                dependencyPath = path.join(nodeModulesPath, scope, name);
            } else {
                // Unscoped package
                dependencyPath = path.join(nodeModulesPath, dependencyName);
            }

            if (await isSymbolicLink(dependencyPath)) {
                const target = await getSymbolicLinkTarget(dependencyPath);
                if (target) {
                    // Determine if this is an external dependency (not in the same workspace)
                    const isExternal = !target.includes('node_modules') || target.startsWith('..');
                    linkedDependencies.push({
                        dependencyName,
                        targetPath: target,
                        isExternal
                    });
                }
            }
        }
    } catch (error: any) {
        logger.warn(`UNLINK_CHECK_FAILED: Unable to check linked dependencies | Package: ${packageName} | Error: ${error.message}`);
    }

    return linkedDependencies;
};

// Helper function to remove symbolic links manually
export const removeSymbolicLink = async (
    packageName: string,
    targetDir: string,
    logger: any,
    isDryRun: boolean = false
): Promise<boolean> => {
    try {
        // Parse package name to get scope and name parts
        const [scope, name] = packageName.startsWith('@')
            ? packageName.split('/')
            : [null, packageName];

        // Create the target path structure
        const nodeModulesPath = path.join(targetDir, 'node_modules');
        let targetPath: string;

        if (scope) {
            // Scoped package: node_modules/@scope/name
            targetPath = path.join(nodeModulesPath, scope, name);
        } else {
            // Unscoped package: node_modules/name
            targetPath = path.join(nodeModulesPath, name);
        }

        if (isDryRun) {
            logger.verbose(`DRY RUN: Would check and remove symlink: ${targetPath}`);
            return true;
        }

        // Check if something exists at the target path
        try {
            const stats = await fs.lstat(targetPath); // Use lstat to not follow symlinks

            if (stats.isSymbolicLink()) {
                // It's a symlink, remove it
                await fs.unlink(targetPath);
                logger.verbose(`Removed symlink: ${targetPath}`);
                return true;
            } else {
                logger.verbose(`Target exists but is not a symlink: ${targetPath}`);
                return false;
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // Nothing exists at target path, nothing to remove
                logger.verbose(`No symlink found at: ${targetPath}`);
                return true;
            } else {
                throw error; // Re-throw unexpected errors
            }
        }
    } catch (error: any) {
        logger.warn(`UNLINK_SYMLINK_REMOVE_FAILED: Unable to remove symlink | Package: ${packageName} | Error: ${error.message}`);
        return false;
    }
};

// Helper function to parse package names and scopes (same as link command)
export const parsePackageArgument = (packageArg: string): { scope: string; packageName?: string } => {
    if (packageArg.startsWith('@')) {
        const parts = packageArg.split('/');
        if (parts.length === 1) {
            // Just a scope like "@fjell"
            return { scope: parts[0] };
        } else {
            // Full package name like "@fjell/core"
            return { scope: parts[0], packageName: packageArg };
        }
    } else {
        throw new Error(`Package argument must start with @ (scope): ${packageArg}`);
    }
};

// Find packages in the workspace that match the given scope or package name
const findMatchingPackages = async (
    targetDirectories: string[],
    scope: string,
    storage: any,
    logger: any,
    packageName?: string
): Promise<Array<{ name: string; path: string; isSource: boolean }>> => {
    const matchingPackages: Array<{ name: string; path: string; isSource: boolean }> = [];

    // Find all package.json files in target directories
    let allPackageJsonFiles: any[] = [];
    for (const targetDirectory of targetDirectories) {
        const packageJsonFiles = await findAllPackageJsonFiles(targetDirectory, storage);
        allPackageJsonFiles = allPackageJsonFiles.concat(packageJsonFiles);
    }

    for (const packageJsonLocation of allPackageJsonFiles) {
        const packageDir = packageJsonLocation.path.replace('/package.json', '');

        try {
            const packageJsonContent = await storage.readFile(packageJsonLocation.path, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonLocation.path);
            const packageJson = validatePackageJson(parsed, packageJsonLocation.path);

            if (!packageJson.name) continue;

            const isInScope = packageJson.name.startsWith(scope + '/');
            const isExactMatch = packageName && packageJson.name === packageName;

            if (isInScope || isExactMatch) {
                matchingPackages.push({
                    name: packageJson.name,
                    path: packageDir,
                    isSource: packageName ? packageJson.name === packageName : isInScope
                });
            }
        } catch (error: any) {
            logger.warn(`Failed to parse ${packageJsonLocation.path}: ${error.message}`);
        }
    }

    return matchingPackages;
};

// Find packages that depend on the target package
const findConsumingPackages = async (
    targetDirectories: string[],
    targetPackageName: string,
    storage: any,
    logger: any
): Promise<Array<{ name: string; path: string }>> => {
    const consumingPackages: Array<{ name: string; path: string }> = [];

    // Find all package.json files in target directories
    let allPackageJsonFiles: any[] = [];
    for (const targetDirectory of targetDirectories) {
        const packageJsonFiles = await findAllPackageJsonFiles(targetDirectory, storage);
        allPackageJsonFiles = allPackageJsonFiles.concat(packageJsonFiles);
    }

    for (const packageJsonLocation of allPackageJsonFiles) {
        const packageDir = packageJsonLocation.path.replace('/package.json', '');

        try {
            const packageJsonContent = await storage.readFile(packageJsonLocation.path, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonLocation.path);
            const packageJson = validatePackageJson(parsed, packageJsonLocation.path);

            if (!packageJson.name) continue;

            // Check if this package depends on the target package
            const dependencyTypes = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
            const hasDependency = dependencyTypes.some(depType =>
                packageJson[depType] && packageJson[depType][targetPackageName]
            );

            if (hasDependency && packageJson.name !== targetPackageName) {
                consumingPackages.push({
                    name: packageJson.name,
                    path: packageDir
                });
            }
        } catch (error: any) {
            logger.warn(`Failed to parse ${packageJsonLocation.path}: ${error.message}`);
        }
    }

    return consumingPackages;
};

const executeInternal = async (runConfig: Config, packageArgument?: string): Promise<string> => {
    const isDryRun = runConfig.dryRun || runConfig.unlink?.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const storage = createStorage();

    // Check if this is a status command
    if (packageArgument === 'status') {
        return await executeStatus(runConfig);
    }

    // Get target directories from config, default to current directory
    const targetDirectories = runConfig.tree?.directories || [process.cwd()];

    if (targetDirectories.length === 1) {
        logger.info(`UNLINK_WORKSPACE_ANALYSIS: Analyzing single workspace directory | Path: ${targetDirectories[0]} | Purpose: Find packages to unlink`);
    } else {
        logger.info(`UNLINK_WORKSPACE_ANALYSIS: Analyzing multiple workspace directories | Paths: ${targetDirectories.join(', ')} | Count: ${targetDirectories.length} | Purpose: Find packages to unlink`);
    }

    // If no package argument provided, implement new behavior for current project
    if (!packageArgument) {
        logger.info('UNLINK_SMART_MODE: Smart unlinking mode activated for current project | Mode: smart | Target: current directory | Purpose: Auto-unlink based on scope');

        const currentDir = process.cwd();
        const packageJsonPath = `${currentDir}/package.json`;

        // Check if we're in a directory with package.json
        if (!(await storage.exists(packageJsonPath))) {
            const message = `No package.json found in current directory: ${currentDir}`;
            logger.warn('UNLINK_NO_PACKAGE_JSON: No package.json found in current directory | Directory: ' + currentDir + ' | Action: Cannot unlink without package.json');
            return message;
        }

        // Parse package.json to get package name
        let packageName: string;
        try {
            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
            const packageJson = validatePackageJson(parsed, packageJsonPath);

            if (!packageJson.name) {
                throw new Error('package.json has no name field');
            }
            packageName = packageJson.name;
        } catch (error: any) {
            const message = `Failed to parse package.json: ${error.message}`;
            logger.error('UNLINK_PACKAGE_NAME_MISSING: package.json must have a name field | Field: name | Requirement: Required for unlinking | Action: Add name field to package.json');
            return message;
        }

        logger.info(`UNLINK_PACKAGE_PROCESSING: Processing package for unlinking | Package: ${packageName} | Action: Remove symlinks and restore registry versions`);

        const cleanNodeModules = runConfig.unlink?.cleanNodeModules || false;
        const externalUnlinkPatterns = runConfig.unlink?.externals || [];

        // Step 0: Handle external dependencies if patterns are specified
        if (externalUnlinkPatterns.length > 0) {
            logger.info(`UNLINK_EXTERNAL_DEPS: Processing external dependencies | Patterns: ${externalUnlinkPatterns.join(', ')} | Purpose: Unlink external packages before main package`);

            // Read package.json to get dependencies
            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
            const packageJson = validatePackageJson(parsed, packageJsonPath);

            const allDependencies = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };

            const externalDependencies = Object.keys(allDependencies).filter(depName =>
                matchesExternalUnlinkPattern(depName, externalUnlinkPatterns)
            );

            if (externalDependencies.length > 0) {
                logger.info(`UNLINK_EXTERNAL_FOUND: Found external dependencies to unlink | Count: ${externalDependencies.length} | Dependencies: ${externalDependencies.join(', ')}`);

                for (const depName of externalDependencies) {
                    try {
                        const success = await removeSymbolicLink(depName, currentDir, logger, isDryRun);
                        if (success) {
                            logger.info(`UNLINK_EXTERNAL_SUCCESS: External dependency unlinked successfully | Dependency: ${depName} | Status: unlinked`);
                        } else {
                            logger.warn(`UNLINK_EXTERNAL_FAILED: Failed to unlink external dependency | Dependency: ${depName} | Status: failed`);
                        }
                    } catch (error: any) {
                        logger.warn(`UNLINK_EXTERNAL_ERROR: Error during external dependency unlink | Dependency: ${depName} | Error: ${error.message}`);
                    }
                }
            } else {
                logger.info('UNLINK_EXTERNAL_NONE: No external dependencies found matching patterns | Patterns: ' + externalUnlinkPatterns.join(', ') + ' | Action: Skipping external unlink');
            }
        }

        if (isDryRun) {
            let dryRunMessage = `DRY RUN: Would execute unlink steps for ${packageName}:\n`;
            if (externalUnlinkPatterns.length > 0) {
                dryRunMessage += `  0. Unlink external dependencies matching patterns: ${externalUnlinkPatterns.join(', ')}\n`;
            }
            dryRunMessage += `  1. npm unlink -g\n`;
            if (cleanNodeModules) {
                dryRunMessage += `  2. rm -rf node_modules package-lock.json\n`;
                dryRunMessage += `  3. npm install\n`;
                dryRunMessage += `  4. Check for remaining links with npm ls --link`;
            } else {
                dryRunMessage += `  2. Check for remaining links with npm ls --link\n`;
                dryRunMessage += `  Note: Use --clean-node-modules flag to also clean and reinstall dependencies`;
            }

            logger.info(dryRunMessage);
            return dryRunMessage;
        }

        // Step 1: Remove global link
        logger.info('UNLINK_GLOBAL_REMOVING: Removing global npm link | Step: 1 | Command: npm unlink -g | Purpose: Remove package from global npm');
        try {
            await run('npm unlink -g');
            logger.info('UNLINK_GLOBAL_SUCCESS: Global link removed successfully | Status: unlinked | Location: global npm');
        } catch (error: any) {
            // This might fail if the package wasn't globally linked, which is OK
            logger.warn(`UNLINK_GLOBAL_SKIP: Failed to remove global link | Error: ${error.message} | Impact: OK if package wasn't linked | Status: continuing`);
        }

        if (cleanNodeModules) {
            // Step 2: Clean node_modules and package-lock.json
            logger.info('UNLINK_CLEANING: Cleaning node_modules and package-lock.json | Command: rm -rf | Purpose: Remove symlinked dependencies');
            try {
                await run('rm -rf node_modules package-lock.json');
                logger.info('UNLINK_CLEAN_SUCCESS: Successfully cleaned node_modules and package-lock.json | Status: removed | Next: Fresh install');
            } catch (error: any) {
                logger.warn(`UNLINK_CLEAN_FAILED: Failed to clean directories | Error: ${error.message} | Impact: May need manual cleanup`);
            }

            // Step 3: Install dependencies
            logger.info('UNLINK_INSTALLING: Installing dependencies from registry | Command: npm install | Purpose: Restore registry versions');
            try {
                await run('npm install');
                logger.info('UNLINK_INSTALL_SUCCESS: Dependencies installed successfully | Source: npm registry | Status: completed');
            } catch (error: any) {
                logger.error(`UNLINK_INSTALL_FAILED: Failed to install dependencies | Error: ${error.message} | Impact: Package may be in inconsistent state`);
                throw error;
            }

            // Step 4: Check for remaining links (suppress output and errors)
            logger.info('UNLINK_CHECK_REMAINING: Checking for remaining symlinks | Purpose: Verify clean unlink | Action: Scan node_modules');
        } else {
            // Step 2: Check for remaining links (suppress output and errors)
            logger.info('UNLINK_CHECK_REMAINING: Checking for remaining symlinks | Mode: skip-reinstall | Purpose: Verify unlink | Action: Scan node_modules');
            logger.info('Note: Use --clean-node-modules flag to also clean and reinstall dependencies');
        }

        try {
            // Use child_process directly to suppress logging and get JSON output
            const util = await import('util');
            const child_process = await import('child_process');
            const execPromise = util.promisify(child_process.exec);

            const result = await execPromise('npm ls --link --json');

            // Parse JSON output to check for links to packages in the same scope
            const packageScope = packageName.includes('/') ? packageName.split('/')[0] : null;

            if (packageScope && result.stdout.trim()) {
                try {
                    const linksData = safeJsonParse(result.stdout, 'npm ls output after unlink');
                    const linkedPackages = Object.keys(linksData.dependencies || {});
                    const scopeLinkedPackages = linkedPackages.filter(pkg => pkg.startsWith(packageScope + '/'));

                    if (scopeLinkedPackages.length > 0) {
                        logger.warn(`UNLINK_REMAINING_LINKS: Found remaining links to packages in scope | Scope: ${packageScope} | Packages: ${scopeLinkedPackages.join(', ')} | Note: May be expected if workspace packages linked`);
                        logger.verbose('UNLINK_REMAINING_NOTE: Remaining links may be expected | Reason: Other workspace packages still linked | Status: normal');
                    } else {
                        logger.info('UNLINK_VERIFY_CLEAN: No problematic links found | Status: clean | Verification: passed');
                    }
                } catch {
                    // If JSON parsing fails, fall back to basic check
                    logger.verbose('Failed to parse npm ls --link --json output, using basic check');
                    if (result.stdout.includes(packageScope)) {
                        logger.warn(`UNLINK_REMAINING_LINKS_BASIC: Found remaining links to scope | Scope: ${packageScope} | Check: basic | Note: May be expected`);
                        logger.verbose('UNLINK_REMAINING_NOTE: Remaining links may be expected | Reason: Other workspace packages still linked | Status: normal');
                    } else {
                        logger.info('UNLINK_VERIFY_CLEAN: No problematic links found | Status: clean | Verification: passed');
                    }
                }
            } else {
                logger.info('UNLINK_VERIFY_CLEAN: No problematic links found | Status: clean | Verification: passed');
            }
        } catch {
            // npm ls --link returns non-zero when there are no links, which is what we want
            // So we only log this at verbose level
            logger.verbose('npm ls --link check completed (non-zero exit is expected when no links exist)');
        }

        const summary = `Successfully unlinked ${packageName}`;
        logger.info(summary);
        return summary;
    }

    // New scope-based unlinking behavior
    logger.info(`UNLINK_EXPLICIT_MODE: Unlinking specific scope/package | Target: ${packageArgument} | Mode: explicit | Purpose: Remove symlinks for package`);

    const { scope, packageName } = parsePackageArgument(packageArgument);
    logger.verbose(`Parsed scope: ${scope}, package: ${packageName || 'all packages in scope'}`);

    // Find matching packages in the workspace
    const matchingPackages = await findMatchingPackages(targetDirectories, scope, storage, logger, packageName);

    if (matchingPackages.length === 0) {
        const message = packageName
            ? `No package found matching: ${packageName}`
            : `No packages found in scope: ${scope}`;
        logger.warn(message);
        return message;
    }

    logger.info(`Found ${matchingPackages.length} matching package(s)`);

    const unlinkedPackages: string[] = [];

    // If specific package name provided, use that; otherwise unlink all packages in scope
    const packagesToUnlink = packageName
        ? matchingPackages.filter(pkg => pkg.name === packageName)
        : matchingPackages;

    for (const pkg of packagesToUnlink) {
        logger.info(`Processing package: ${pkg.name}`);

        // Step A: Find all packages that depend on this package and unlink them first
        const consumingPackages = await findConsumingPackages(targetDirectories, pkg.name, storage, logger);

        if (consumingPackages.length === 0) {
            logger.info(`No consuming packages found for: ${pkg.name}`);
        } else {
            logger.info(`Found ${consumingPackages.length} consuming package(s) for: ${pkg.name}`);

            for (const consumer of consumingPackages) {
                try {
                    const consumerOriginalCwd = process.cwd();
                    process.chdir(consumer.path);

                    try {
                        if (isDryRun) {
                            logger.info(`DRY RUN: Would run 'npm unlink ${pkg.name}' in: ${consumer.path}`);
                        } else {
                            logger.verbose(`Running 'npm unlink ${pkg.name}' in consumer: ${consumer.path}`);
                            await runSecure('npm', ['unlink', pkg.name]);
                            logger.info(`UNLINK_CONSUMER_SUCCESS: Consumer unlinked from package | Consumer: ${consumer.name} | Package: ${pkg.name} | Status: unlinked`);
                        }
                    } finally {
                        process.chdir(consumerOriginalCwd);
                    }
                } catch (error: any) {
                    // npm unlink can fail if package wasn't linked, but that's OK
                    logger.warn(`UNLINK_CONSUMER_FAILED: Failed to unlink consumer | Consumer: ${consumer.name} | Package: ${pkg.name} | Error: ${error.message}`);
                }
            }
        }

        // Step B: Run 'npm unlink' in the source package directory
        try {
            const originalCwd = process.cwd();
            process.chdir(pkg.path);

            try {
                if (isDryRun) {
                    logger.info(`DRY RUN: Would run 'npm unlink' in: ${pkg.path}`);
                } else {
                    logger.verbose(`Running 'npm unlink' in source: ${pkg.path}`);
                    await run('npm unlink');
                    logger.info(`UNLINK_SOURCE_SUCCESS: Source package unlinked | Package: ${pkg.name} | Status: unlinked`);
                }
            } finally {
                process.chdir(originalCwd);
            }

            unlinkedPackages.push(pkg.name);
        } catch (error: any) {
            // npm unlink can fail if package wasn't linked, but that's OK
            logger.warn(`UNLINK_SOURCE_FAILED: Failed to unlink source package | Package: ${pkg.name} | Error: ${error.message}`);
            unlinkedPackages.push(pkg.name); // Still count as success
        }
    }

    const summary = `Successfully unlinked ${unlinkedPackages.length} package(s): ${unlinkedPackages.join(', ')}`;
    logger.info(summary);
    return summary;
};

// Status function to show what's currently linked (same as link command)
const executeStatus = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const storage = createStorage();

    // Get target directories from config, default to current directory
    const targetDirectories = runConfig.tree?.directories || [process.cwd()];

    if (targetDirectories.length === 1) {
        logger.info(`UNLINK_STATUS_CHECK: Checking link status in directory | Directory: ${targetDirectories[0]} | Purpose: Show current symlinks`);
    } else {
        logger.info(`UNLINK_STATUS_CHECK: Checking link status in directories | Directories: ${targetDirectories.join(', ')} | Count: ${targetDirectories.length} | Purpose: Show current symlinks`);
    }

    // Find all packages in the workspace
    let allPackageJsonFiles: any[] = [];
    for (const targetDirectory of targetDirectories) {
        const packageJsonFiles = await findAllPackageJsonFiles(targetDirectory, storage);
        allPackageJsonFiles = allPackageJsonFiles.concat(packageJsonFiles);
    }

    const packageStatuses: Array<{
        name: string;
        path: string;
        linkedDependencies: Array<{ dependencyName: string; targetPath: string; isExternal: boolean }>;
    }> = [];

    for (const packageJsonLocation of allPackageJsonFiles) {
        const packageDir = packageJsonLocation.path.replace('/package.json', '');

        try {
            const packageJsonContent = await storage.readFile(packageJsonLocation.path, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonLocation.path);
            const packageJson = validatePackageJson(parsed, packageJsonLocation.path);

            if (!packageJson.name) continue;

            const linkedDependencies = await findLinkedDependencies(packageDir, packageJson.name, storage, logger);

            if (linkedDependencies.length > 0) {
                packageStatuses.push({
                    name: packageJson.name,
                    path: packageDir,
                    linkedDependencies
                });
            }
        } catch (error: any) {
            logger.warn(`Failed to parse ${packageJsonLocation.path}: ${error.message}`);
        }
    }

    if (packageStatuses.length === 0) {
        return 'No linked dependencies found in workspace.';
    }

    // Format the output
    let output = `Found ${packageStatuses.length} package(s) with linked dependencies:\n\n`;

    for (const packageStatus of packageStatuses) {
        output += `📦 ${packageStatus.name}\n`;
        output += `   Path: ${packageStatus.path}\n`;

        if (packageStatus.linkedDependencies.length > 0) {
            output += `   Linked dependencies:\n`;
            for (const dep of packageStatus.linkedDependencies) {
                const type = dep.isExternal ? '🔗 External' : '🔗 Internal';
                output += `     ${type} ${dep.dependencyName} -> ${dep.targetPath}\n`;
            }
        }
        output += '\n';
    }

    return output;
};

export const execute = async (runConfig: Config, packageArgument?: string): Promise<string> => {
    try {
        // Check if this is a status command from direct parameter
        if (packageArgument === 'status') {
            return await executeStatus(runConfig);
        }

        // Use packageArgument from runConfig if not provided as parameter
        const finalPackageArgument = packageArgument || runConfig.unlink?.packageArgument;

        // Check if this is a status command from config
        if (finalPackageArgument === 'status') {
            return await executeStatus(runConfig);
        }

        return await executeInternal(runConfig, finalPackageArgument);
    } catch (error: any) {
        const logger = getLogger();
        logger.error(`unlink failed: ${error.message}`);
        throw error;
    }
};
