// Tree and dependency management commands
export { execute as link } from './commands/link';
export { execute as unlink } from './commands/unlink';
export { execute as tree } from './commands/tree';
export { execute as updates } from './commands/updates';
export { execute as versions } from './commands/versions';

// Tree-specific utilities
export * from './util/npmOptimizations';
export * from './util/performanceTracker';

// Package execution context for isolation (re-exported from tree-execution)
export { PackageExecutionContext, PackageContextFactory } from '@grunnverk/tree-execution';
export type { PackageContextOptions, RepositoryInfo } from '@grunnverk/tree-execution';

