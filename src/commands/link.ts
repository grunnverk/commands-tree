import { getLogger, getDryRunLogger, Config } from '@eldrforge/core';
import { run, runSecure, safeJsonParse, validatePackageJson } from '@eldrforge/git-tools';
import { findAllPackageJsonFiles } from '@eldrforge/commands-git';
import { createStorage } from '@eldrforge/shared';
import fs from 'fs/promises';
import path from 'path';

// Helper function to check if a path is a symbolic link
const isSymbolicLink = async (filePath: string): Promise<boolean> => {
    try {
        const stats = await fs.lstat(filePath);
        return stats.isSymbolicLink();
    } catch {
        return false;
    }
};

// Helper function to get the target of a symbolic link
const getSymbolicLinkTarget = async (filePath: string): Promise<string | null> => {
    try {
        const target = await fs.readlink(filePath);
        return target;
    } catch {
        return null;
    }
};

// Helper function to find all linked dependencies in a package
const findLinkedDependencies = async (
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
        logger.warn(`LINKED_DEPS_CHECK_FAILED: Unable to check linked dependencies | Package: ${packageName} | Error: ${error.message}`);
    }

    return linkedDependencies;
};

// Helper function to check if a dependency matches any external link patterns
const matchesExternalLinkPattern = (dependencyName: string, externalLinkPatterns: string[]): boolean => {
    if (!externalLinkPatterns || externalLinkPatterns.length === 0) {
        return false;
    }

    return externalLinkPatterns.some(pattern => {
        // Simple string matching - could be enhanced with glob patterns later
        return dependencyName === pattern || dependencyName.startsWith(pattern);
    });
};

// Helper function to create symbolic links manually
const createSymbolicLink = async (
    packageName: string,
    sourcePath: string,
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
            const scopeDir = path.join(nodeModulesPath, scope);
            targetPath = path.join(scopeDir, name);

            if (!isDryRun) {
                // Ensure scope directory exists
                await fs.mkdir(scopeDir, { recursive: true });
            }
        } else {
            // Unscoped package: node_modules/name
            targetPath = path.join(nodeModulesPath, name);

            if (!isDryRun) {
                // Ensure node_modules directory exists
                await fs.mkdir(nodeModulesPath, { recursive: true });
            }
        }

        if (isDryRun) {
            logger.verbose(`DRY RUN: Would create symlink: ${targetPath} -> ${sourcePath}`);
            return true;
        }

        // Create the symbolic link using relative path for better portability
        const relativePath = path.relative(path.dirname(targetPath), sourcePath);

        // Check if something already exists at the target path
        try {
            const stats = await fs.lstat(targetPath); // Use lstat to not follow symlinks

            if (stats.isSymbolicLink()) {
                // It's a symlink, check if it points to the correct target
                const existingLink = await fs.readlink(targetPath);
                if (existingLink === relativePath) {
                    logger.verbose(`Symlink already exists and points to correct target: ${targetPath} -> ${relativePath}`);
                    return true;
                } else {
                    logger.info(`SYMLINK_FIXING: Correcting symlink target | Path: ${targetPath} | Old Target: ${existingLink} | New Target: ${relativePath}`);
                    await fs.unlink(targetPath);
                    await fs.symlink(relativePath, targetPath, 'dir');
                    logger.info(`SYMLINK_FIXED: Successfully updated symlink | Path: ${targetPath} | Target: ${relativePath} | Type: directory`);
                    return true;
                }
            } else if (stats.isDirectory()) {
                // It's a directory, remove it
                logger.warn(`SYMLINK_DIRECTORY_CONFLICT: Removing existing directory to create symlink | Path: ${targetPath} | Type: directory | Action: Remove and replace with symlink`);
                await fs.rm(targetPath, { recursive: true, force: true });
                await fs.symlink(relativePath, targetPath, 'dir');
                logger.info(`SYMLINK_CREATED: Successfully created symlink after directory removal | Path: ${targetPath} | Target: ${relativePath} | Type: directory`);
                return true;
            } else {
                // It's a file, remove it
                logger.warn(`SYMLINK_FILE_CONFLICT: Removing existing file to create symlink | Path: ${targetPath} | Type: file | Action: Remove and replace with symlink`);
                await fs.unlink(targetPath);
                await fs.symlink(relativePath, targetPath, 'dir');
                logger.info(`SYMLINK_CREATED: Successfully created symlink after file removal | Path: ${targetPath} | Target: ${relativePath} | Type: directory`);
                return true;
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // Nothing exists at target path, create the symlink
                await fs.symlink(relativePath, targetPath, 'dir');
                logger.verbose(`Created symlink: ${targetPath} -> ${relativePath}`);
                return true;
            } else {
                throw error; // Re-throw unexpected errors
            }
        }
    } catch (error: any) {
        logger.warn(`SYMLINK_CREATE_FAILED: Unable to create symlink | Package: ${packageName} | Error: ${error.message} | Status: failed`);
        return false;
    }
};

// Helper function to parse package names and scopes
const parsePackageArgument = (packageArg: string): { scope: string; packageName?: string } => {
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
            logger.warn(`PACKAGE_JSON_PARSE_FAILED: Unable to parse package.json | Path: ${packageJsonLocation.path} | Error: ${error.message}`);
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
    const isDryRun = runConfig.dryRun || runConfig.link?.dryRun || false;
    const logger = getDryRunLogger(isDryRun);
    const storage = createStorage();

    // Check if this is a status command
    if (packageArgument === 'status') {
        return await executeStatus(runConfig);
    }

    // Get target directories from config, default to current directory
    const targetDirectories = runConfig.tree?.directories || [process.cwd()];

    if (targetDirectories.length === 1) {
        logger.info(`WORKSPACE_ANALYSIS: Analyzing single workspace directory | Path: ${targetDirectories[0]} | Purpose: Find linkable packages`);
    } else {
        logger.info(`WORKSPACE_ANALYSIS: Analyzing multiple workspace directories | Paths: ${targetDirectories.join(', ')} | Count: ${targetDirectories.length} | Purpose: Find linkable packages across workspaces`);
    }

    // If no package argument provided, use new smart same-scope linking behavior
    if (!packageArgument) {
        logger.info('LINK_SMART_MODE: Smart linking mode activated for current project | Mode: smart | Target: current directory | Purpose: Auto-link dependencies based on scope');

        // Work in current directory only - read the package.json
        const currentDir = process.cwd();
        const packageJsonPath = `${currentDir}/package.json`;

        let currentPackageJson;
        try {
            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
            currentPackageJson = validatePackageJson(parsed, packageJsonPath);
        } catch (error: any) {
            const message = `PACKAGE_JSON_NOT_FOUND: No valid package.json in current directory | Error: ${error.message} | Action: Cannot proceed with smart linking`;
            logger.error(message);
            return message;
        }

        if (!currentPackageJson.name) {
            const message = 'PACKAGE_NAME_MISSING: package.json must have a name field | Field: name | Requirement: Required for linking | Action: Add name field to package.json';
            logger.error(message);
            return message;
        }

        // Extract the scope from the current package name
        const currentScope = currentPackageJson.name.startsWith('@')
            ? currentPackageJson.name.split('/')[0]
            : null;

        if (!currentScope) {
            const message = 'PACKAGE_SCOPE_MISSING: Package must have scoped name for smart linking | Format Required: @scope/package | Current: ' + currentPackageJson.name + ' | Action: Use scoped package name';
            logger.warn(message);
            return message;
        }

        logger.info(`CURRENT_PACKAGE_IDENTIFIED: Current package identified for smart linking | Package: ${currentPackageJson.name} | Scope: ${currentScope} | Path: ${currentDir}`);

        // Step 1: Link the current package globally (optional - continue even if this fails)
        try {
            if (isDryRun) {
                logger.info(`SELF_LINK_DRY_RUN: Would link current package globally | Mode: dry-run | Package: ${currentPackageJson.name} | Command: npm link`);
            } else {
                logger.verbose(`SELF_LINK_STARTING: Registering package globally | Package: ${currentPackageJson.name} | Command: npm link | Purpose: Make available for dependency linking`);
                await run('npm link');
                logger.info(`SELF_LINK_SUCCESS: Current package linked globally | Package: ${currentPackageJson.name} | Location: Global npm | Purpose: Make available for linking`);
            }
        } catch (error: any) {
            logger.warn(`SELF_LINK_FAILED: Unable to self-link current package | Package: ${currentPackageJson.name} | Error: ${error.message} | Impact: Continuing with dependency linking`);
            logger.info(`LINK_CONTINUING: Proceeding with dependency linking despite self-link failure | Next: Link matching dependencies`);
        }

        // Step 2: Find same-scope dependencies in current package
        const allDependencies = {
            ...currentPackageJson.dependencies,
            ...currentPackageJson.devDependencies
        };

        const sameScopeDependencies = Object.keys(allDependencies).filter(depName =>
            depName.startsWith(currentScope + '/')
        );

        // Step 2.5: Find external dependencies that match external link patterns
        const externalLinkPatterns = runConfig.link?.externals || [];
        const externalDependencies = Object.keys(allDependencies).filter(depName =>
            matchesExternalLinkPattern(depName, externalLinkPatterns)
        );

        const allDependenciesToLink = [...sameScopeDependencies, ...externalDependencies];

        if (allDependenciesToLink.length === 0) {
            logger.info(`No same-scope or external dependencies found for ${currentScope}`);
            if (isDryRun) {
                return `DRY RUN: Would self-link, no dependencies found to link`;
            } else {
                return `Self-linked ${currentPackageJson.name}, no dependencies to link`;
            }
        }

        logger.info(`Found ${sameScopeDependencies.length} same-scope dependencies: ${sameScopeDependencies.join(', ')}`);
        if (externalDependencies.length > 0) {
            logger.info(`Found ${externalDependencies.length} external dependencies matching patterns: ${externalDependencies.join(', ')}`);
        }

        // Step 2.6: Handle external dependencies using scopeRoots configuration
        const scopeRoots = runConfig.link?.scopeRoots || {};
        const globallyLinkedViaScopeRoots: string[] = [];

        if (Object.keys(scopeRoots).length > 0 && externalDependencies.length > 0) {
            logger.info('Using scopeRoots configuration to discover and link external packages...');

            for (const depName of externalDependencies) {
                const depScope = depName.startsWith('@') ? depName.split('/')[0] : null;
                const scopeRoot = depScope ? scopeRoots[depScope] : null;

                if (scopeRoot) {
                    logger.verbose(`Processing ${depName} with scope ${depScope} -> ${scopeRoot}`);

                    // Convert relative path to absolute
                    const absoluteScopeRoot = path.resolve(currentDir, scopeRoot);
                    logger.verbose(`Scanning scope root directory: ${absoluteScopeRoot}`);

                    try {
                        // Look for package with matching name in the scope directory
                        const expectedPackageName = depName.startsWith('@') ? depName.split('/')[1] : depName;
                        const packageDir = path.join(absoluteScopeRoot, expectedPackageName);
                        const packageJsonPath = path.join(packageDir, 'package.json');

                        logger.verbose(`Checking for package at: ${packageDir}`);

                        try {
                            const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
                            const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
                            const packageJson = validatePackageJson(parsed, packageJsonPath);

                            if (packageJson.name === depName) {
                                logger.info(`Found matching package: ${depName} at ${packageDir}`);

                                if (isDryRun) {
                                    logger.info(`DRY RUN: Would run 'npm link' in: ${packageDir}`);
                                    globallyLinkedViaScopeRoots.push(depName);
                                } else {
                                    // Step A: Run 'npm link' in the source package directory
                                    const originalCwd = process.cwd();
                                    try {
                                        process.chdir(packageDir);
                                        logger.verbose(`Running 'npm link' in source: ${packageDir}`);
                                        await run('npm link');
                                        logger.info(`LINK_SOURCE_SCOPE_ROOTS: Source linked via scopeRoots | Package: ${depName} | Method: scopeRoots | Status: linked`);
                                        globallyLinkedViaScopeRoots.push(depName);
                                    } catch (linkError: any) {
                                        logger.warn(`LINK_SOURCE_FAILED: Failed to link source package | Package: ${depName} | Error: ${linkError.message}`);
                                    } finally {
                                        process.chdir(originalCwd);
                                    }
                                }
                            } else {
                                logger.verbose(`Package name mismatch: expected ${depName}, found ${packageJson.name}`);
                            }
                        } catch (packageError: any) {
                            logger.verbose(`Package not found or invalid: ${packageJsonPath} - ${packageError.message}`);
                        }
                    } catch (error: any) {
                        logger.verbose(`Error processing scope ${depScope}: ${error.message}`);
                    }
                } else {
                    logger.verbose(`No scope root configured for ${depScope}`);
                }
            }

            if (globallyLinkedViaScopeRoots.length > 0) {
                logger.info(`Successfully prepared ${globallyLinkedViaScopeRoots.length} packages via scopeRoots: ${globallyLinkedViaScopeRoots.join(', ')}`);
            }
        }

        // Step 3: Get globally linked packages directories (only if we have dependencies to link)
        let globallyLinkedPackages: { [key: string]: string } = {};
        try {
            if (isDryRun) {
                logger.info(`DRY RUN: Would run 'npm ls --link -g -p' to discover linked package directories`);
                logger.info(`DRY RUN: Would attempt to link dependencies: ${allDependenciesToLink.join(', ')}`);
                return `DRY RUN: Would self-link and attempt to link ${allDependenciesToLink.length} dependencies`;
            } else {
                logger.verbose(`Discovering globally linked package directories...`);
                const result = await run('npm ls --link -g -p');
                const resultStr = typeof result === 'string' ? result : result.stdout;

                // Parse the directory paths - each line is a directory path
                const directoryPaths = resultStr.trim().split('\n').filter(line => line.trim() !== '');

                // Extract package names from directory paths and build a map
                for (const dirPath of directoryPaths) {
                    try {
                        // Read the package.json to get the actual package name
                        const packageJsonPath = `${dirPath.trim()}/package.json`;
                        const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
                        const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
                        const packageJson = validatePackageJson(parsed, packageJsonPath);

                        if (packageJson.name) {
                            globallyLinkedPackages[packageJson.name] = dirPath.trim();
                        }
                    } catch (packageError: any) {
                        logger.verbose(`Could not read package.json from ${dirPath}: ${packageError.message}`);
                    }
                }

                const linkedCount = Object.keys(globallyLinkedPackages).length;
                logger.verbose(`Found ${linkedCount} globally linked package(s)`);
            }
        } catch (error: any) {
            logger.warn(`Failed to get globally linked packages (continuing anyway): ${error.message}`);
            globallyLinkedPackages = {};
        }

        // Step 4: Link same-scope dependencies that are available globally using manual symlinks
        const linkedDependencies: string[] = [];

        for (const depName of allDependenciesToLink) {
            const sourcePath = globallyLinkedPackages[depName];
            if (sourcePath) {
                try {
                    logger.verbose(`Linking dependency: ${depName} from ${sourcePath}`);

                    // Create the symbolic link manually using the directory path directly
                    const success = await createSymbolicLink(depName, sourcePath, currentDir, logger, isDryRun);

                    if (success) {
                        logger.info(`LINK_DEPENDENCY_SUCCESS: Linked dependency successfully | Dependency: ${depName} | Status: symlink-created`);
                        linkedDependencies.push(depName);
                    } else {
                        logger.warn(`LINK_DEPENDENCY_FAILED: Failed to link dependency | Dependency: ${depName} | Status: failed`);
                    }
                } catch (error: any) {
                    logger.warn(`⚠️ Failed to link ${depName}: ${error.message}`);
                }
            } else {
                logger.verbose(`Skipping ${depName} (not globally linked)`);
            }
        }

        const summary = linkedDependencies.length > 0
            ? `Self-linked ${currentPackageJson.name} and linked ${linkedDependencies.length} dependencies: ${linkedDependencies.join(', ')}`
            : `Self-linked ${currentPackageJson.name}, no dependencies were available to link`;

        // Step 5: Regenerate package-lock.json without modifying node_modules
        try {
            if (isDryRun) {
                logger.info(`DRY RUN: Would run 'npm install --package-lock-only --no-audit --no-fund' to regenerate package-lock.json`);
            } else {
                logger.verbose(`Running 'npm install --package-lock-only --no-audit --no-fund' to regenerate package-lock.json without touching node_modules...`);
                await run('npm install --package-lock-only --no-audit --no-fund');
                logger.info(`LINK_LOCK_REGENERATED: Regenerated package-lock.json successfully | File: package-lock.json | Status: updated`);
            }
        } catch (error: any) {
            logger.warn(`LINK_LOCK_REGEN_FAILED: Failed to regenerate package-lock.json | Error: ${error.message} | Impact: Lock file may be out of sync`);
        }

        logger.info(summary);
        return summary;
    }

    // New scope-based linking behavior
    logger.info(`LINK_SCOPE_MODE: Linking scope or specific package | Target: ${packageArgument} | Mode: scope-based | Purpose: Link packages by scope`);

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

    const linkedPackages: string[] = [];

    // If specific package name provided, use that; otherwise link all packages in scope
    const packagesToLink = packageName
        ? matchingPackages.filter(pkg => pkg.name === packageName)
        : matchingPackages;

    for (const pkg of packagesToLink) {
        logger.info(`Processing package: ${pkg.name}`);

        // Step A: Run 'npm link' in the source package directory
        try {
            const originalCwd = process.cwd();
            process.chdir(pkg.path);

            try {
                if (isDryRun) {
                    logger.info(`DRY RUN: Would run 'npm link' in: ${pkg.path}`);
                } else {
                    logger.verbose(`Running 'npm link' in source: ${pkg.path}`);
                    await run('npm link');
                    logger.info(`LINK_SOURCE_SUCCESS: Source package linked globally | Package: ${pkg.name} | Status: linked`);
                }
            } finally {
                process.chdir(originalCwd);
            }

            // Step B: Find all packages that depend on this package and link them
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
                                logger.info(`DRY RUN: Would run 'npm link ${pkg.name}' in: ${consumer.path}`);
                            } else {
                                logger.verbose(`Running 'npm link ${pkg.name}' in consumer: ${consumer.path}`);
                                await runSecure('npm', ['link', pkg.name]);
                                logger.info(`LINK_CONSUMER_SUCCESS: Consumer linked to package | Consumer: ${consumer.name} | Package: ${pkg.name} | Status: linked`);
                            }
                        } finally {
                            process.chdir(consumerOriginalCwd);
                        }
                    } catch (error: any) {
                        logger.error(`LINK_CONSUMER_FAILED: Failed to link package in consumer | Package: ${pkg.name} | Consumer: ${consumer.name} | Error: ${error.message}`);
                        throw new Error(`Failed to link ${pkg.name} in consumer ${consumer.name}: ${error.message}`);
                    }
                }
            }

            linkedPackages.push(pkg.name);
        } catch (error: any) {
            logger.error(`LINK_SOURCE_PACKAGE_FAILED: Failed to link source package | Package: ${pkg.name} | Error: ${error.message}`);
            throw new Error(`Failed to link source package ${pkg.name}: ${error.message}`);
        }
    }

    const summary = `Successfully linked ${linkedPackages.length} package(s): ${linkedPackages.join(', ')}`;

    // Final step: Regenerate package-lock.json files in all affected packages without modifying node_modules
    if (!isDryRun) {
        logger.info(`LINK_LOCK_REGENERATING_ALL: Regenerating package-lock.json files in all packages | Mode: lockfile-only | Purpose: Update lock files after linking`);

        // Get all unique consuming packages
        const allConsumingPackages = new Set<string>();
        for (const pkg of packagesToLink) {
            const consumingPackages = await findConsumingPackages(targetDirectories, pkg.name, storage, logger);
            consumingPackages.forEach(consumer => allConsumingPackages.add(consumer.path));
        }

        // Also include the source packages
        packagesToLink.forEach(pkg => allConsumingPackages.add(pkg.path));

        // Run lockfile-only install in each package
        for (const packagePath of allConsumingPackages) {
            try {
                const originalCwd = process.cwd();
                process.chdir(packagePath);

                try {
                    logger.verbose(`Running 'npm install --package-lock-only --no-audit --no-fund' in: ${packagePath}`);
                    await run('npm install --package-lock-only --no-audit --no-fund');
                    logger.verbose(`LINK_LOCK_PACKAGE_REGENERATED: Regenerated package-lock.json | Path: ${packagePath} | Status: updated`);
                } finally {
                    process.chdir(originalCwd);
                }
            } catch (error: any) {
                logger.warn(`LINK_LOCK_PACKAGE_REGEN_FAILED: Failed to regenerate package-lock.json | Path: ${packagePath} | Error: ${error.message}`);
            }
        }

        logger.info(`LINK_LOCK_ALL_REGENERATED: Regenerated package-lock.json files in all packages | Package Count: ${allConsumingPackages.size} | Status: completed`);
    } else {
        logger.info(`DRY RUN: Would run 'npm install --package-lock-only --no-audit --no-fund' to regenerate package-lock.json files in all packages`);
    }

    logger.info(summary);
    return summary;
};

// Status function to show what's currently linked
const executeStatus = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const storage = createStorage();

    // Get target directories from config, default to current directory
    const targetDirectories = runConfig.tree?.directories || [process.cwd()];

    if (targetDirectories.length === 1) {
        logger.info(`🔍 Checking link status in: ${targetDirectories[0]}`);
    } else {
        logger.info(`🔍 Checking link status in: ${targetDirectories.join(', ')}`);
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
        // Use packageArgument from runConfig if not provided as parameter
        const finalPackageArgument = packageArgument || runConfig.link?.packageArgument;
        return await executeInternal(runConfig, finalPackageArgument);
    } catch (error: any) {
        const logger = getLogger();
        logger.error(`link failed: ${error.message}`);
        throw error;
    }
};

