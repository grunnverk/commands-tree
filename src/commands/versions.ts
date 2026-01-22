#!/usr/bin/env node
/**
 * Versions command - Update dependency versions in package.json files
 *
 * This command helps manage dependency versions across packages in a workspace.
 * It can update dependencies to use semantic versioning patterns (^, ~, etc.)
 * for packages within the same scope.
 *
 * Supported subcommands:
 * - minor: Updates all same-scope dependencies to use ^ (caret) range for minor updates
 */

import path from 'path';
import fs from 'fs/promises';
import { getLogger, Config } from '@grunnverk/core';
import { createStorage } from '@grunnverk/shared';
import { safeJsonParse, validatePackageJson } from '@grunnverk/git-tools';


// Simplified package info for version management (distinct from tree-core's PackageInfo)
interface VersionPackageInfo {
    name: string;
    version: string;
    packageJsonPath: string;
}

/**
 * Discover all package.json files in the workspace
 */
const discoverPackages = async (
    directories: string[],
    logger: any
): Promise<VersionPackageInfo[]> => {
    const storage = createStorage();
    const packages: VersionPackageInfo[] = [];

    for (const directory of directories) {
        logger.verbose(`Scanning directory: ${directory}`);

        try {
            const packageJsonPath = path.join(directory, 'package.json');

            if (await storage.exists(packageJsonPath)) {
                const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
                const parsed = safeJsonParse(packageJsonContent, packageJsonPath);
                const packageJson = validatePackageJson(parsed, packageJsonPath);

                if (packageJson.name) {
                    packages.push({
                        name: packageJson.name,
                        version: packageJson.version,
                        packageJsonPath
                    });
                    logger.verbose(`Found package: ${packageJson.name}@${packageJson.version}`);
                }
            } else {
                // Look for nested package.json files in subdirectories
                try {
                    const entries = await fs.readdir(directory, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                            const subDir = path.join(directory, entry.name);
                            const subPackages = await discoverPackages([subDir], logger);
                            packages.push(...subPackages);
                        }
                    }
                } catch (error) {
                    logger.debug(`Could not scan subdirectories in ${directory}: ${error}`);
                }
            }
        } catch (error: any) {
            logger.warn(`VERSIONS_DIR_PROCESS_FAILED: Failed to process directory | Directory: ${directory} | Error: ${error.message}`);
        }
    }

    return packages;
};

/**
 * Extract scope from package name (e.g., "@grunnverk/package" -> "@grunnverk")
 */
const getPackageScope = (packageName: string): string | null => {
    if (packageName.startsWith('@')) {
        const parts = packageName.split('/');
        if (parts.length >= 2) {
            return parts[0];
        }
    }
    return null;
};



/**
 * Normalize version string to major.minor format (remove patch version)
 */
const normalizeToMinorVersion = (versionString: string): string => {
    // Extract the version number, preserving any prefix (^, ~, >=, etc.)
    const match = versionString.match(/^([^0-9]*)([0-9]+\.[0-9]+)(\.[0-9]+)?(.*)$/);

    if (match) {
        const [, prefix, majorMinor, , suffix] = match;
        return `${prefix}${majorMinor}${suffix || ''}`;
    }

    // If it doesn't match the expected pattern, return as-is
    return versionString;
};

/**
 * Update dependencies in a package.json to normalize same-scope dependencies to major.minor format
 */
const updateDependenciesMinor = async (
    packageInfo: VersionPackageInfo,
    allPackages: VersionPackageInfo[],
    isDryRun: boolean,
    logger: any
): Promise<boolean> => {
    const storage = createStorage();
    const currentScope = getPackageScope(packageInfo.name);

    if (!currentScope) {
        logger.verbose(`Skipping ${packageInfo.name} - not a scoped package`);
        return false;
    }

    logger.verbose(`Processing ${packageInfo.name} for scope ${currentScope}`);

    try {
        const packageJsonContent = await storage.readFile(packageInfo.packageJsonPath, 'utf-8');
        const parsed = safeJsonParse(packageJsonContent, packageInfo.packageJsonPath);
        const packageJson = validatePackageJson(parsed, packageInfo.packageJsonPath);

        const sectionsToUpdate = ['dependencies', 'devDependencies', 'peerDependencies'];
        let hasChanges = false;

        // Create a set of same-scope package names for quick lookup
        const sameScopePackageNames = new Set<string>();
        for (const pkg of allPackages) {
            const pkgScope = getPackageScope(pkg.name);
            if (pkgScope === currentScope) {
                sameScopePackageNames.add(pkg.name);
            }
        }

        for (const section of sectionsToUpdate) {
            const deps = packageJson[section];
            if (!deps) continue;

            for (const [depName, currentVersion] of Object.entries(deps)) {
                // Update if this is a same-scope dependency (check scope, not just discovered packages)
                const depScope = getPackageScope(depName);
                if (depScope === currentScope) {
                    const normalizedVersion = normalizeToMinorVersion(currentVersion as string);

                    if (currentVersion !== normalizedVersion) {
                        if (isDryRun) {
                            logger.info(`VERSIONS_WOULD_NORMALIZE: Would normalize dependency version | Mode: dry-run | Section: ${section} | Dependency: ${depName} | Current: ${currentVersion} | Normalized: ${normalizedVersion}`);
                        } else {
                            logger.info(`VERSIONS_NORMALIZING: Normalizing dependency version | Section: ${section} | Dependency: ${depName} | Current: ${currentVersion} | Normalized: ${normalizedVersion}`);
                            deps[depName] = normalizedVersion;
                        }
                        hasChanges = true;
                    }
                }
            }
        }

        if (hasChanges && !isDryRun) {
            // Write updated package.json
            await storage.writeFile(
                packageInfo.packageJsonPath,
                JSON.stringify(packageJson, null, 2) + '\n',
                'utf-8'
            );
            logger.info(`VERSIONS_PACKAGE_UPDATED: Updated dependencies in package | Package: ${packageInfo.name} | Status: saved`);
        }

        return hasChanges;

    } catch (error: any) {
        logger.warn(`VERSIONS_PACKAGE_UPDATE_FAILED: Failed to update dependencies | Package: ${packageInfo.name} | Error: ${error.message}`);
        return false;
    }
};

/**
 * Execute the versions minor command
 */
const executeMinor = async (runConfig: Config): Promise<string> => {
    const logger = getLogger();
    const isDryRun = runConfig.dryRun || false;

    logger.info('VERSIONS_NORMALIZE_STARTING: Normalizing same-scope dependencies | Format: major.minor | Purpose: Standardize version format across packages');

    // Determine directories to scan
    const directories = runConfig.versions?.directories ||
                       runConfig.contextDirectories ||
                       [process.cwd()];

    if (directories.length === 0) {
        directories.push(process.cwd());
    }

    logger.verbose(`Scanning directories: ${directories.join(', ')}`);

    // Discover all packages
    const allPackages = await discoverPackages(directories, logger);

    if (allPackages.length === 0) {
        logger.warn('VERSIONS_NO_PACKAGES: No packages found in specified directories | Directories: ' + (runConfig.tree?.directories || []).join(', ') + ' | Action: Nothing to normalize');
        return 'No packages found to process.';
    }

    logger.info(`VERSIONS_PACKAGES_FOUND: Found packages for normalization | Count: ${allPackages.length} | Status: Analyzing`);

    // Group packages by scope
    const packagesByScope = new Map<string, VersionPackageInfo[]>();
    const unscopedPackages: VersionPackageInfo[] = [];

    for (const pkg of allPackages) {
        const scope = getPackageScope(pkg.name);
        if (scope) {
            if (!packagesByScope.has(scope)) {
                packagesByScope.set(scope, []);
            }
            packagesByScope.get(scope)!.push(pkg);
        } else {
            unscopedPackages.push(pkg);
        }
    }

    logger.info(`VERSIONS_SCOPES_FOUND: Found package scopes | Count: ${packagesByScope.size} | Scopes: ${Array.from(packagesByScope.keys()).join(', ')}`);
    if (unscopedPackages.length > 0) {
        logger.info(`VERSIONS_UNSCOPED_PACKAGES: Found unscoped packages | Count: ${unscopedPackages.length} | Action: Will be skipped | Reason: Only scoped packages supported`);
        // Log each unscoped package being skipped
        for (const pkg of unscopedPackages) {
            logger.verbose(`Skipping ${pkg.name} - not a scoped package`);
        }
    }

    let totalUpdated = 0;
    let totalChanges = 0;

    // Process each scope
    for (const [scope, packages] of packagesByScope) {
        logger.info(`\nVERSIONS_SCOPE_PROCESSING: Processing packages in scope | Scope: ${scope} | Package Count: ${packages.length} | Action: Normalize versions`);

        for (const pkg of packages) {
            const hasChanges = await updateDependenciesMinor(pkg, allPackages, isDryRun, logger);
            if (hasChanges) {
                totalChanges++;
            }
        }
        totalUpdated += packages.length;
    }

    const verb = isDryRun ? 'Would update' : 'Updated';
    const summary = `${verb} ${totalChanges} of ${totalUpdated} packages with dependency changes.`;

    if (isDryRun) {
        logger.info(`\nVERSIONS_DRY_RUN_COMPLETE: Dry run completed | Mode: dry-run | Summary: ${summary}`);
        return `Dry run complete. ${summary}`;
    } else {
        logger.info(`\nVERSIONS_UPDATE_COMPLETE: Dependencies updated successfully | Status: completed | Summary: ${summary}`);
        return `Dependencies updated successfully. ${summary}`;
    }
};

/**
 * Main execute function for the versions command
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const subcommand = runConfig.versions?.subcommand;

    if (!subcommand) {
        throw new Error('Versions command requires a subcommand. Use: kodrdriv versions minor');
    }

    switch (subcommand) {
        case 'minor':
            return await executeMinor(runConfig);
        default:
            throw new Error(`Unknown versions subcommand: ${subcommand}. Supported: minor`);
    }
};
