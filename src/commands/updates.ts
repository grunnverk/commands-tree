#!/usr/bin/env node
/**
 * Updates command - Run npm-check-updates with scoped patterns or update inter-project dependencies
 *
 * This command provides a convenient way to update dependencies matching specific scopes:
 * - Can target specific scopes like "@fjell" or "@getdidthey"
 * - Works at both project level and tree level (across multiple packages)
 * - Uses npm-check-updates to update matching packages from npm registry
 * - Can update inter-project dependencies based on tree state (--inter-project mode)
 * - Can generate dependency analysis reports (--report mode)
 * - Can run AI-powered analysis with upgrade recommendations (--analyze mode)
 *
 * Examples:
 *   kodrdriv updates @fjell                   # Update @fjell/* packages in current project
 *   kodrdriv tree updates @fjell              # Update @fjell/* packages across all projects in tree
 *   kodrdriv updates @getdidthey              # Update @getdidthey/* packages in current project
 *   kodrdriv updates --inter-project          # Update inter-project deps based on tree state
 *   kodrdriv tree updates --inter-project     # Update all inter-project deps in tree
 *   kodrdriv updates                          # Update all configured default scopes
 *   kodrdriv tree updates                     # Update all configured scopes across tree
 *   kodrdriv tree updates --report            # Generate dependency analysis report
 *   kodrdriv updates --analyze                # Run AI analysis with upgrade recommendations
 *   kodrdriv updates --analyze --strategy conservative  # Use conservative upgrade strategy
 */

import { getDryRunLogger, Config, toAIConfig, createStorageAdapter, createLoggerAdapter } from '@eldrforge/core';
import { run, safeJsonParse } from '@eldrforge/git-tools';
import { createStorage } from '@eldrforge/shared';
import path from 'path';
import fs from 'fs/promises';

// Types for dependency analysis
type DependencyInfo = {
    name: string;
    version: string;
    section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
    packageName: string;
    packagePath: string;
};

/**
 * Scan a package directory and collect all dependencies
 */
const collectPackageDependencies = async (
    packageDir: string,
    logger: any
): Promise<DependencyInfo[]> => {
    const storage = createStorage();
    const packageJsonPath = path.join(packageDir, 'package.json');
    const dependencies: DependencyInfo[] = [];

    if (!await storage.exists(packageJsonPath)) {
        return dependencies;
    }

    try {
        const content = await storage.readFile(packageJsonPath, 'utf-8');
        const packageJson = safeJsonParse(content, packageJsonPath);
        const packageName = packageJson.name || path.basename(packageDir);

        const sections: Array<'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'> = [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies'
        ];

        for (const section of sections) {
            const deps = packageJson[section];
            if (deps && typeof deps === 'object') {
                for (const [name, version] of Object.entries(deps)) {
                    dependencies.push({
                        name,
                        version: version as string,
                        section,
                        packageName,
                        packagePath: packageDir
                    });
                }
            }
        }
    } catch (error: any) {
        logger.warn(`Failed to read package.json in ${packageDir}: ${error.message}`);
    }

    return dependencies;
};

/**
 * Find all packages in the current directory tree
 */
const findPackagesInTree = async (
    baseDir: string,
    logger: any
): Promise<string[]> => {
    const storage = createStorage();
    const packages: string[] = [];

    // Check if current directory is a package
    const currentPackageJson = path.join(baseDir, 'package.json');
    if (await storage.exists(currentPackageJson)) {
        packages.push(baseDir);
    }

    // Look for packages in subdirectories (one level deep for monorepo structure)
    try {
        const entries = await fs.readdir(baseDir);
        for (const entry of entries) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;

            const subDir = path.join(baseDir, entry);
            try {
                const stat = await fs.stat(subDir);
                if (stat.isDirectory()) {
                    const subPackageJson = path.join(subDir, 'package.json');
                    if (await storage.exists(subPackageJson)) {
                        packages.push(subDir);
                    }
                }
            } catch {
                // Ignore stat errors
            }
        }
    } catch (error: any) {
        logger.warn(`Failed to read directory ${baseDir}: ${error.message}`);
    }

    return packages;
};

/**
 * Collect dependencies organized by package
 */
type PackageDependencyData = {
    packageName: string;
    packagePath: string;
    dependencies: DependencyInfo[];
    devDependencies: DependencyInfo[];
    peerDependencies: DependencyInfo[];
    optionalDependencies: DependencyInfo[];
};

/**
 * Generate dependency analysis report with two views:
 * 1. By-Project View - Shows full dependency tree for each project
 * 2. Top-Level View - Shows all dependencies aggregated across tree
 */
const generateDependencyReport = async (
    runConfig: Config,
    logger: any
): Promise<string> => {
    const baseDir = process.cwd();
    logger.info('UPDATES_REPORT_STARTING: Generating dependency analysis report | Mode: report | Purpose: Analyze dependencies across tree');

    // Find all packages
    const packageDirs = await findPackagesInTree(baseDir, logger);
    logger.info(`UPDATES_REPORT_PACKAGES: Found packages to analyze | Count: ${packageDirs.length}`);

    // Collect dependencies organized by package
    const packageData: PackageDependencyData[] = [];
    const allDependencies = new Map<string, DependencyInfo[]>();
    let totalDeps = 0;

    for (const packageDir of packageDirs) {
        const deps = await collectPackageDependencies(packageDir, logger);
        totalDeps += deps.length;

        const packageName = deps[0]?.packageName || path.basename(packageDir);

        packageData.push({
            packageName,
            packagePath: packageDir,
            dependencies: deps.filter(d => d.section === 'dependencies'),
            devDependencies: deps.filter(d => d.section === 'devDependencies'),
            peerDependencies: deps.filter(d => d.section === 'peerDependencies'),
            optionalDependencies: deps.filter(d => d.section === 'optionalDependencies'),
        });

        for (const dep of deps) {
            const existing = allDependencies.get(dep.name) || [];
            existing.push(dep);
            allDependencies.set(dep.name, existing);
        }
    }

    // Sort packageData by name
    packageData.sort((a, b) => a.packageName.localeCompare(b.packageName));

    // Find conflicts (same dep, different versions)
    const conflicts = new Map<string, DependencyInfo[]>();
    for (const [name, usages] of allDependencies) {
        const versions = new Set(usages.map(u => u.version));
        if (versions.size > 1) {
            conflicts.set(name, usages);
        }
    }

    // Find overlaps (same dep used by multiple packages)
    const overlaps = new Map<string, DependencyInfo[]>();
    for (const [name, usages] of allDependencies) {
        const packages = new Set(usages.map(u => u.packageName));
        if (packages.size > 1) {
            overlaps.set(name, usages);
        }
    }

    // Generate report
    const lines: string[] = [];
    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════════════╗');
    lines.push('║              DEPENDENCY ANALYSIS REPORT                           ║');
    lines.push('╚═══════════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push(`📦 Packages analyzed: ${packageDirs.length}`);
    lines.push(`📋 Total dependencies: ${totalDeps}`);
    lines.push(`🔗 Unique dependencies: ${allDependencies.size}`);
    lines.push(`⚠️  Version conflicts: ${conflicts.size}`);
    lines.push(`🔄 Shared dependencies: ${overlaps.size}`);
    lines.push('');

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW 1: BY-PROJECT VIEW
    // ═══════════════════════════════════════════════════════════════════════
    lines.push('');
    lines.push('┌───────────────────────────────────────────────────────────────────┐');
    lines.push('│  VIEW 1: BY-PROJECT DEPENDENCY TREE                              │');
    lines.push('└───────────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const pkg of packageData) {
        const totalCount = pkg.dependencies.length + pkg.devDependencies.length +
                          pkg.peerDependencies.length + pkg.optionalDependencies.length;

        lines.push(`┌─ 📦 ${pkg.packageName} (${totalCount} total)`);
        lines.push(`│  Path: ${pkg.packagePath}`);

        // Dependencies
        if (pkg.dependencies.length > 0) {
            lines.push('│');
            lines.push(`│  ├─ dependencies (${pkg.dependencies.length})`);
            const sortedDeps = [...pkg.dependencies].sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < sortedDeps.length; i++) {
                const dep = sortedDeps[i];
                const isLast = i === sortedDeps.length - 1 &&
                              pkg.devDependencies.length === 0 &&
                              pkg.peerDependencies.length === 0 &&
                              pkg.optionalDependencies.length === 0;
                const hasConflict = conflicts.has(dep.name);
                const marker = hasConflict ? '⚠️' : '  ';
                const prefix = isLast ? '│     └─' : '│     ├─';
                lines.push(`${prefix} ${marker} ${dep.name} @ ${dep.version}`);
            }
        }

        // DevDependencies
        if (pkg.devDependencies.length > 0) {
            lines.push('│');
            lines.push(`│  ├─ devDependencies (${pkg.devDependencies.length})`);
            const sortedDevDeps = [...pkg.devDependencies].sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < sortedDevDeps.length; i++) {
                const dep = sortedDevDeps[i];
                const isLast = i === sortedDevDeps.length - 1 &&
                              pkg.peerDependencies.length === 0 &&
                              pkg.optionalDependencies.length === 0;
                const hasConflict = conflicts.has(dep.name);
                const marker = hasConflict ? '⚠️' : '  ';
                const prefix = isLast ? '│     └─' : '│     ├─';
                lines.push(`${prefix} ${marker} ${dep.name} @ ${dep.version}`);
            }
        }

        // PeerDependencies
        if (pkg.peerDependencies.length > 0) {
            lines.push('│');
            lines.push(`│  ├─ peerDependencies (${pkg.peerDependencies.length})`);
            const sortedPeerDeps = [...pkg.peerDependencies].sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < sortedPeerDeps.length; i++) {
                const dep = sortedPeerDeps[i];
                const isLast = i === sortedPeerDeps.length - 1 &&
                              pkg.optionalDependencies.length === 0;
                const hasConflict = conflicts.has(dep.name);
                const marker = hasConflict ? '⚠️' : '  ';
                const prefix = isLast ? '│     └─' : '│     ├─';
                lines.push(`${prefix} ${marker} ${dep.name} @ ${dep.version}`);
            }
        }

        // OptionalDependencies
        if (pkg.optionalDependencies.length > 0) {
            lines.push('│');
            lines.push(`│  └─ optionalDependencies (${pkg.optionalDependencies.length})`);
            const sortedOptDeps = [...pkg.optionalDependencies].sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < sortedOptDeps.length; i++) {
                const dep = sortedOptDeps[i];
                const hasConflict = conflicts.has(dep.name);
                const marker = hasConflict ? '⚠️' : '  ';
                const prefix = i === sortedOptDeps.length - 1 ? '│     └─' : '│     ├─';
                lines.push(`${prefix} ${marker} ${dep.name} @ ${dep.version}`);
            }
        }

        lines.push('│');
        lines.push('└───────────────────────────────────────────────────────────────────');
        lines.push('');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW 2: TOP-LEVEL / GLOBAL VIEW
    // ═══════════════════════════════════════════════════════════════════════
    lines.push('');
    lines.push('┌───────────────────────────────────────────────────────────────────┐');
    lines.push('│  VIEW 2: TOP-LEVEL DEPENDENCY ANALYSIS                           │');
    lines.push('└───────────────────────────────────────────────────────────────────┘');
    lines.push('');

    // Version conflicts section
    if (conflicts.size > 0) {
        lines.push('┌─ ⚠️  VERSION CONFLICTS (same dependency, different versions)');
        lines.push('│');

        const sortedConflicts = Array.from(conflicts.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        for (let ci = 0; ci < sortedConflicts.length; ci++) {
            const [name, usages] = sortedConflicts[ci];
            const isLastConflict = ci === sortedConflicts.length - 1;

            lines.push(`│  ${isLastConflict ? '└─' : '├─'} 📦 ${name}`);

            // Group by version
            const byVersion = new Map<string, DependencyInfo[]>();
            for (const usage of usages) {
                const existing = byVersion.get(usage.version) || [];
                existing.push(usage);
                byVersion.set(usage.version, existing);
            }

            const versions = Array.from(byVersion.entries());
            for (let vi = 0; vi < versions.length; vi++) {
                const [version, versionUsages] = versions[vi];
                const isLastVersion = vi === versions.length - 1;
                const packages = versionUsages.map(u => u.packageName).join(', ');
                const indent = isLastConflict ? '      ' : '│     ';
                lines.push(`${indent}${isLastVersion ? '└─' : '├─'} ${version}`);
                lines.push(`${indent}${isLastVersion ? '  ' : '│ '}   Used by: ${packages}`);
            }
        }
        lines.push('');
    } else {
        lines.push('✓ No version conflicts found');
        lines.push('');
    }

    // All dependencies sorted alphabetically with usage info
    lines.push('┌─ 📋 ALL DEPENDENCIES (alphabetical)');
    lines.push('│');

    const sortedAllDeps = Array.from(allDependencies.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    for (let i = 0; i < sortedAllDeps.length; i++) {
        const [name, usages] = sortedAllDeps[i];
        const isLast = i === sortedAllDeps.length - 1;
        const versions = [...new Set(usages.map(u => u.version))];
        const packageCount = new Set(usages.map(u => u.packageName)).size;
        const hasConflict = versions.length > 1;

        const versionStr = versions.length === 1 ? versions[0] : versions.join(' | ');
        const marker = hasConflict ? '⚠️' : '  ';
        const sharedIndicator = packageCount > 1 ? ` (${packageCount} packages)` : '';

        lines.push(`│  ${isLast ? '└─' : '├─'} ${marker} ${name}`);
        lines.push(`│  ${isLast ? '  ' : '│ '}    Version: ${versionStr}${sharedIndicator}`);

        if (hasConflict || packageCount > 1) {
            const usedBy = usages.map(u => `${u.packageName}:${u.version}`);
            const uniqueUsedBy = [...new Set(usedBy)];
            lines.push(`│  ${isLast ? '  ' : '│ '}    Used by: ${uniqueUsedBy.join(', ')}`);
        }
    }

    lines.push('');

    // Shared dependencies summary
    if (overlaps.size > 0) {
        lines.push('┌─ 🔄 MOST SHARED DEPENDENCIES (top 20)');
        lines.push('│');

        // Sort by number of packages using (descending)
        const sortedOverlaps = Array.from(overlaps.entries())
            .map(([name, usages]) => ({
                name,
                usages,
                packageCount: new Set(usages.map(u => u.packageName)).size
            }))
            .sort((a, b) => b.packageCount - a.packageCount)
            .slice(0, 20);

        for (let i = 0; i < sortedOverlaps.length; i++) {
            const { name, usages, packageCount } = sortedOverlaps[i];
            const isLast = i === sortedOverlaps.length - 1;
            const versions = [...new Set(usages.map(u => u.version))];
            const versionStr = versions.length === 1 ? versions[0] : `[${versions.join(', ')}]`;
            const status = versions.length > 1 ? '⚠️' : '✓ ';

            lines.push(`│  ${isLast ? '└─' : '├─'} ${status} ${name} @ ${versionStr}`);
            lines.push(`│  ${isLast ? '  ' : '│ '}    Shared by ${packageCount} packages`);
        }

        lines.push('');
    }

    // Package dependency counts summary
    lines.push('┌─ 📊 PACKAGE SUMMARY');
    lines.push('│');

    const packageCounts = packageData.map(pkg => ({
        name: pkg.packageName,
        deps: pkg.dependencies.length,
        devDeps: pkg.devDependencies.length,
        peerDeps: pkg.peerDependencies.length,
        optDeps: pkg.optionalDependencies.length,
        total: pkg.dependencies.length + pkg.devDependencies.length +
               pkg.peerDependencies.length + pkg.optionalDependencies.length
    })).sort((a, b) => b.total - a.total);

    for (let i = 0; i < packageCounts.length; i++) {
        const pkg = packageCounts[i];
        const isLast = i === packageCounts.length - 1;
        lines.push(`│  ${isLast ? '└─' : '├─'} ${pkg.name}`);
        lines.push(`│  ${isLast ? '  ' : '│ '}    ${pkg.deps} deps | ${pkg.devDeps} dev | ${pkg.peerDeps} peer | ${pkg.optDeps} optional | ${pkg.total} total`);
    }

    lines.push('');
    lines.push('╔═══════════════════════════════════════════════════════════════════╗');
    lines.push('║                      END OF REPORT                                ║');
    lines.push('╚═══════════════════════════════════════════════════════════════════╝');
    lines.push('');

    const report = lines.join('\n');

    // Output report
    logger.info('UPDATES_REPORT_COMPLETE: Dependency analysis complete');

    return report;
};

/**
 * Collect report data for AI analysis
 */
const collectReportData = async (logger: any) => {
    const baseDir = process.cwd();
    const packageDirs = await findPackagesInTree(baseDir, logger);

    // Collect dependencies organized by package
    const packageData: PackageDependencyData[] = [];
    const allDependencies = new Map<string, DependencyInfo[]>();
    let totalDeps = 0;

    for (const packageDir of packageDirs) {
        const deps = await collectPackageDependencies(packageDir, logger);
        totalDeps += deps.length;

        const packageName = deps[0]?.packageName || path.basename(packageDir);

        packageData.push({
            packageName,
            packagePath: packageDir,
            dependencies: deps.filter(d => d.section === 'dependencies'),
            devDependencies: deps.filter(d => d.section === 'devDependencies'),
            peerDependencies: deps.filter(d => d.section === 'peerDependencies'),
            optionalDependencies: deps.filter(d => d.section === 'optionalDependencies'),
        });

        for (const dep of deps) {
            const existing = allDependencies.get(dep.name) || [];
            existing.push(dep);
            allDependencies.set(dep.name, existing);
        }
    }

    // Find conflicts
    const conflicts: Array<{
        packageName: string;
        versions: string[];
        usages: Array<{ version: string; usedBy: string[] }>;
    }> = [];

    for (const [name, usages] of allDependencies) {
        const versions = [...new Set(usages.map(u => u.version))];
        if (versions.length > 1) {
            const usagesByVersion = new Map<string, string[]>();
            for (const usage of usages) {
                const existing = usagesByVersion.get(usage.version) || [];
                existing.push(usage.packageName);
                usagesByVersion.set(usage.version, existing);
            }

            conflicts.push({
                packageName: name,
                versions: [...versions],
                usages: [...usagesByVersion.entries()].map(([version, usedBy]) => ({
                    version,
                    usedBy,
                })),
            });
        }
    }

    // Find shared dependencies
    const sharedDependencies = [...allDependencies.entries()]
        .filter(([, usages]) => new Set(usages.map(u => u.packageName)).size > 1)
        .map(([name, usages]) => ({
            name,
            versions: [...new Set(usages.map(u => u.version))],
            packageCount: new Set(usages.map(u => u.packageName)).size,
        }))
        .sort((a, b) => b.packageCount - a.packageCount);

    // Package summaries
    const packageSummaries = packageData.map(pkg => ({
        name: pkg.packageName,
        deps: pkg.dependencies.length,
        devDeps: pkg.devDependencies.length,
        peerDeps: pkg.peerDependencies.length,
        total: pkg.dependencies.length + pkg.devDependencies.length +
               pkg.peerDependencies.length + pkg.optionalDependencies.length,
    }));

    return {
        packageCount: packageDirs.length,
        totalDependencies: totalDeps,
        uniqueDependencies: allDependencies.size,
        conflictCount: conflicts.length,
        conflicts,
        sharedDependencies,
        packageSummaries,
    };
};

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
 * Run updates for a single scope
 */
const runScopedUpdate = async (
    scope: string,
    isDryRun: boolean,
    logger: any
): Promise<string> => {
    logger.info(`UPDATES_NCU_STARTING: Running npm-check-updates for scope | Scope: ${scope} | Tool: npm-check-updates | Purpose: Find outdated dependencies`);

    // Build the npm-check-updates command
    const ncuCommand = `npx npm-check-updates '/${scope.replace('@', '^@')}//' -u`;

    logger.info(`UPDATES_NCU_EXECUTING: Executing npm-check-updates command | Command: ${ncuCommand} | Scope: ${scope}`);

    if (isDryRun) {
        logger.info(`Would run: ${ncuCommand}`);
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

    return hasUpdates ? `Updated ${scope}` : `No updates for ${scope}`;
};

/**
 * Execute the updates command
 */
export const execute = async (runConfig: Config): Promise<string> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    // Check if this is report or analyze mode
    // Note: 'report', 'analyze', 'scopes', 'strategy' are new config options that may not be in the published @eldrforge/core yet
    const updatesConfig = runConfig.updates as {
        report?: boolean;
        analyze?: boolean;
        scopes?: string[];
        scope?: string;
        interProject?: boolean;
        strategy?: 'latest' | 'conservative' | 'compatible';
    } | undefined;

    if (updatesConfig?.report || updatesConfig?.analyze) {
        // Generate the base report
        const report = await generateDependencyReport(runConfig, logger);

        // If only report mode, return the report
        if (!updatesConfig?.analyze) {
            return report;
        }

        // Run AI-powered analysis
        logger.info('UPDATES_ANALYZE_STARTING: Running AI-powered dependency analysis | Mode: analyze | Purpose: Generate upgrade recommendations');

        try {
            // Dynamically import ai-service to avoid dependency issues
            const { runAgenticDependencyAnalysis, formatDependencyAnalysisReport } = await import('@eldrforge/ai-service');

            // Collect report data for the AI
            const reportData = await collectReportData(logger);

            const aiConfig = toAIConfig(runConfig);
            const outputDir = runConfig.outputDirectory || 'output/kodrdriv';

            const analysisResult = await runAgenticDependencyAnalysis({
                reportData,
                strategy: updatesConfig?.strategy || 'latest',
                model: aiConfig.model || 'gpt-4o',
                maxIterations: 15,
                debug: runConfig.debug,
                storage: createStorageAdapter(outputDir),
                logger: createLoggerAdapter(runConfig.verbose || false),
                openaiReasoning: aiConfig.reasoning,
            });

            // Format and return both reports
            const analysisReport = formatDependencyAnalysisReport(analysisResult);

            return report + '\n' + analysisReport;
        } catch (error: any) {
            logger.error(`UPDATES_ANALYZE_FAILED: AI analysis failed | Error: ${error.message}`);
            return report + `\n\n⚠️  AI Analysis failed: ${error.message}\n`;
        }
    }

    // Check if this is inter-project mode
    const interProjectMode = updatesConfig?.interProject || false;

    if (interProjectMode) {
        // Inter-project dependency update mode
        const scope = updatesConfig?.scope;

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

    // Get scope(s) to update
    const explicitScope = updatesConfig?.scope || runConfig.tree?.packageArgument;
    const configuredScopes = updatesConfig?.scopes || runConfig.publish?.scopedDependencyUpdates;

    // Determine which scopes to update
    let scopesToUpdate: string[] = [];

    if (explicitScope) {
        // Single scope provided via CLI
        scopesToUpdate = [explicitScope];
    } else if (configuredScopes && configuredScopes.length > 0) {
        // Use configured default scopes
        scopesToUpdate = configuredScopes;
        logger.info(`UPDATES_USING_CONFIGURED_SCOPES: Using configured scopes | Scopes: ${scopesToUpdate.join(', ')} | Source: config`);
    } else {
        // No scope provided and no defaults configured
        throw new Error(
            'No scope specified and no default scopes configured.\n\n' +
            'Usage:\n' +
            '  kodrdriv updates <scope>           # Update a specific scope\n' +
            '  kodrdriv tree updates <scope>      # Update scope across tree\n' +
            '  kodrdriv tree updates --report     # Generate dependency report\n\n' +
            'Or configure default scopes in your .kodrdriv/config.yml:\n' +
            '  updates:\n' +
            '    scopes:\n' +
            '      - "@riotprompt"\n' +
            '      - "@eldrforge"\n\n' +
            'Or use publish.scopedDependencyUpdates for tree publish integration.'
        );
    }

    // Validate all scopes
    for (const scope of scopesToUpdate) {
        if (!scope.startsWith('@')) {
            throw new Error(`Invalid scope "${scope}". Scope must start with @ (e.g., "@fjell")`);
        }
    }

    // Run updates for each scope
    const results: string[] = [];
    let anyUpdates = false;

    for (const scope of scopesToUpdate) {
        try {
            const result = await runScopedUpdate(scope, isDryRun, logger);
            results.push(result);
            if (result.startsWith('Updated')) {
                anyUpdates = true;
            }
        } catch (error: any) {
            logger.error(`UPDATES_NCU_FAILED: Failed to run npm-check-updates | Scope: ${scope} | Error: ${error.message} | Impact: Dependencies not updated`);
            results.push(`Failed: ${scope} - ${error.message}`);
        }
    }

    // Run npm install if any updates were made
    if (anyUpdates && !isDryRun) {
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

    logger.info(`UPDATES_NCU_SUCCESS: Successfully processed updates | Scopes: ${scopesToUpdate.join(', ')} | Status: completed`);

    if (scopesToUpdate.length === 1) {
        return `Updated dependencies matching ${scopesToUpdate[0]} scope`;
    }
    return `Processed ${scopesToUpdate.length} scopes:\n${results.map(r => `  - ${r}`).join('\n')}`;
};
