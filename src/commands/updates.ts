#!/usr/bin/env node
/**
 * Updates command - Run npm-check-updates with scoped patterns or update inter-project dependencies
 *
 * This command provides a convenient way to update dependencies matching specific scopes:
 * - Can target specific scopes like "@fjell" or "@getdidthey"
 * - Works at both project level and tree level (across multiple packages)
 * - Uses npm-check-updates to update matching packages from npm registry
 * - Can update inter-project dependencies based on tree state (--inter-project mode)
 *
 * Examples:
 *   kodrdriv updates @fjell                   # Update @fjell/* packages in current project
 *   kodrdriv tree updates @fjell              # Update @fjell/* packages across all projects in tree
 *   kodrdriv updates @getdidthey              # Update @getdidthey/* packages in current project
 *   kodrdriv updates --inter-project          # Update inter-project deps based on tree state
 *   kodrdriv tree updates --inter-project     # Update all inter-project deps in tree
 */

import { getDryRunLogger, Config } from '@eldrforge/core';
import { run, safeJsonParse } from '@eldrforge/git-tools';
import { createStorage } from '@eldrforge/shared';
import path from 'path';

/**
 * Update inter-project dependencies in package.json based on current tree state
 */
const updateInterProjectDependencies = async (
    packageDir: string,
    scope: string,
    isDryRun: boolean,
    logger: any
): Promise<{ hasChanges: boolean; updated: string[] }> => {
    const storage = createStorage();
    const packageJsonPath = path.join(packageDir, 'package.json');

    if (!await storage.exists(packageJsonPath)) {
        logger.verbose('No package.json found, skipping dependency updates');
        return { hasChanges: false, updated: [] };
    }

    const updated: string[] = [];
    let hasChanges = false;

    try {
        const packageJsonContent = await storage.readFile(packageJsonPath, 'utf-8');
        const packageJson = safeJsonParse(packageJsonContent, packageJsonPath);

        const sectionsToUpdate = ['dependencies', 'devDependencies', 'peerDependencies'];

        // Collect all dependencies matching the scope
        const depsToUpdate: Array<{ section: string; name: string; currentVersion: string }> = [];

        for (const section of sectionsToUpdate) {
            const deps = packageJson[section];
            if (deps) {
                for (const [depName, depVersion] of Object.entries(deps)) {
                    if (depName.startsWith(scope)) {
                        depsToUpdate.push({
                            section,
                            name: depName,
                            currentVersion: depVersion as string
                        });
                    }
                }
            }
        }

        if (depsToUpdate.length === 0) {
            logger.info(`UPDATES_NO_DEPS_FOUND: No dependencies matching scope | Scope: ${scope} | Package Dir: ${packageDir} | Status: No updates needed`);
            return { hasChanges: false, updated: [] };
        }

        logger.info(`UPDATES_DEPS_FOUND: Found dependencies matching scope | Scope: ${scope} | Count: ${depsToUpdate.length} | Action: Will check and update versions`);

        // For each dependency, find its package.json and get the current version
        for (const dep of depsToUpdate) {
            try {
                // Look for package in parent directories or node_modules
                let depVersion: string | null = null;

                // First try to find in tree (sibling packages)
                const parentDir = path.dirname(packageDir);
                const siblingPackageJson = path.join(parentDir, dep.name.split('/').pop()!, 'package.json');

                if (await storage.exists(siblingPackageJson)) {
                    const siblingContent = await storage.readFile(siblingPackageJson, 'utf-8');
                    const siblingPackage = safeJsonParse(siblingContent, siblingPackageJson);
                    if (siblingPackage.name === dep.name) {
                        depVersion = siblingPackage.version;
                        logger.verbose(`Found ${dep.name}@${depVersion} in tree`);
                    }
                }

                // Fall back to npm to get latest published version
                if (!depVersion) {
                    try {
                        const { stdout } = await run(`npm view ${dep.name} version`);
                        depVersion = stdout.trim();
                        logger.verbose(`Found ${dep.name}@${depVersion} on npm`);
                    } catch {
                        logger.warn(`UPDATES_VERSION_NOT_FOUND: Could not find version for dependency | Dependency: ${dep.name} | Action: Skipping | Reason: Not found in tree or npm`);
                        continue;
                    }
                }

                const newVersion = `^${depVersion}`;
                if (dep.currentVersion !== newVersion) {
                    if (isDryRun) {
                        logger.info(`UPDATES_WOULD_UPDATE: Would update dependency | Mode: dry-run | Section: ${dep.section} | Dependency: ${dep.name} | Current: ${dep.currentVersion} | New: ${newVersion}`);
                    } else {
                        logger.info(`UPDATES_UPDATING: Updating dependency version | Section: ${dep.section} | Dependency: ${dep.name} | Current: ${dep.currentVersion} | New: ${newVersion}`);
                        packageJson[dep.section][dep.name] = newVersion;
                    }
                    hasChanges = true;
                    updated.push(`${dep.name}: ${dep.currentVersion} → ${newVersion}`);
                }
            } catch (error: any) {
                logger.warn(`UPDATES_DEP_UPDATE_FAILED: Failed to update dependency | Dependency: ${dep.name} | Error: ${error.message}`);
            }
        }

        if (hasChanges && !isDryRun) {
            await storage.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
            logger.info(`UPDATES_PACKAGE_COMPLETE: Updated dependencies in package.json | Count: ${updated.length} | File: package.json | Status: saved`);
        }

    } catch (error: any) {
        logger.warn(`UPDATES_INTER_PROJECT_FAILED: Failed to update inter-project dependencies | Error: ${error.message} | Impact: Dependencies not updated`);
    }

    return { hasChanges, updated };
};

/**
 * Execute the updates command
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    // Check if this is inter-project mode
    const interProjectMode = runConfig.updates?.interProject || false;

    if (interProjectMode) {
        // Inter-project dependency update mode
        const scope = runConfig.updates?.scope;

        if (!scope) {
            throw new Error('Scope parameter is required for inter-project updates. Usage: kodrdriv updates --inter-project <scope>');
        }

        if (!scope.startsWith('@')) {
            throw new Error(`Invalid scope "${scope}". Scope must start with @ (e.g., "@fjell")`);
        }

        logger.info(`UPDATES_INTER_PROJECT_STARTING: Updating inter-project dependencies | Scope: ${scope} | Type: inter-project | Purpose: Sync dependency versions`);

        const result = await updateInterProjectDependencies(process.cwd(), scope, isDryRun, logger);

        if (result.hasChanges && !isDryRun) {
            logger.info('UPDATES_NPM_INSTALL: Running npm install to update lock file | Command: npm install | Purpose: Synchronize package-lock.json with changes');
            try {
                await run('npm install');
                logger.info('UPDATES_LOCK_FILE_UPDATED: Lock file updated successfully | File: package-lock.json | Status: synchronized');
            } catch (error: any) {
                logger.error(`UPDATES_NPM_INSTALL_FAILED: Failed to run npm install | Error: ${error.message} | Impact: Lock file not updated`);
                throw new Error(`Failed to update lock file: ${error.message}`);
            }
        }

        if (result.updated.length > 0) {
            logger.info(`UPDATES_INTER_PROJECT_COMPLETE: Updated inter-project dependencies | Count: ${result.updated.length} | Status: completed`);
            result.updated.forEach(update => logger.info(`UPDATES_DEP_UPDATED: ${update}`));
        } else {
            logger.info('UPDATES_INTER_PROJECT_NONE: No inter-project dependency updates needed | Status: All dependencies current');
        }

        return `Updated ${result.updated.length} inter-project dependencies`;
    }

    // Original scope-based npm-check-updates mode
    const scope = runConfig.updates?.scope || runConfig.tree?.packageArgument;

    if (!scope) {
        throw new Error('Scope parameter is required. Usage: kodrdriv updates <scope> or kodrdriv updates --inter-project <scope>');
    }

    // Validate that scope looks like a valid npm scope (starts with @)
    if (!scope.startsWith('@')) {
        throw new Error(`Invalid scope "${scope}". Scope must start with @ (e.g., "@fjell")`);
    }

    logger.info(`UPDATES_NCU_STARTING: Running npm-check-updates for scope | Scope: ${scope} | Tool: npm-check-updates | Purpose: Find outdated dependencies`);

    // Build the npm-check-updates command
    const ncuCommand = `npx npm-check-updates '/${scope.replace('@', '^@')}//' -u`;

    logger.info(`UPDATES_NCU_EXECUTING: Executing npm-check-updates command | Command: ${ncuCommand} | Scope: ${scope}`);

    try {
        if (isDryRun) {
            logger.info(`Would run: ${ncuCommand}`);
            logger.info('Would run: npm install');
            return `Would update dependencies matching ${scope} scope`;
        }

        // Execute npm-check-updates
        const result = await run(ncuCommand);

        if (result.stdout) {
            logger.info('UPDATES_NCU_OUTPUT: npm-check-updates output | Status: completed');
            result.stdout.split('\n').forEach(line => {
                if (line.trim()) {
                    logger.info(`   ${line}`);
                }
            });
        }

        if (result.stderr) {
            logger.info('UPDATES_NCU_WARNINGS: npm-check-updates produced warnings | Type: warnings');
            result.stderr.split('\n').forEach(line => {
                if (line.trim()) {
                    logger.info(`   ${line}`);
                }
            });
        }

        // Check if package.json was actually modified
        const hasUpdates = result.stdout && !result.stdout.includes('All dependencies match the latest package versions');

        if (hasUpdates) {
            logger.info('UPDATES_NCU_INSTALL: Running npm install after ncu updates | Command: npm install | Purpose: Update lock file with new versions');
            try {
                const installResult = await run('npm install');
                if (installResult.stdout) {
                    logger.verbose('npm install output:');
                    installResult.stdout.split('\n').forEach(line => {
                        if (line.trim()) {
                            logger.verbose(`   ${line}`);
                        }
                    });
                }
                logger.info('UPDATES_NCU_LOCK_UPDATED: Lock file updated successfully after ncu | File: package-lock.json | Status: synchronized');
            } catch (installError: any) {
                logger.error(`UPDATES_NCU_INSTALL_FAILED: Failed to run npm install after ncu | Error: ${installError.message} | Impact: Lock file not synchronized`);
                throw new Error(`Failed to update lock file after dependency updates: ${installError.message}`);
            }
        }

        logger.info(`UPDATES_NCU_SUCCESS: Successfully updated dependencies | Scope: ${scope} | Status: completed | Files: package.json, package-lock.json`);
        return `Updated dependencies matching ${scope} scope`;

    } catch (error: any) {
        logger.error(`UPDATES_NCU_FAILED: Failed to run npm-check-updates | Scope: ${scope} | Error: ${error.message} | Impact: Dependencies not updated`);
        throw new Error(`Failed to update dependencies: ${error.message}`);
    }
};
