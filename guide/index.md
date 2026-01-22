# @grunnverk/commands-tree - Agentic Guide

## Purpose

Tree and dependency management commands for kodrdriv monorepo workflows.

## Commands

- `link` - Link workspace packages
- `unlink` - Restore registry versions
- `tree` - Dependency tree traversal
- `updates` - Update scoped dependencies
- `versions` - Manage version patterns

## Dependencies

- @grunnverk/core - Shared infrastructure
- @grunnverk/commands-git - Git commands (for tree commit)
- @grunnverk/tree-core - Dependency graph analysis
- @grunnverk/tree-execution - Parallel execution engine

## Package Structure

```
src/
├── commands/
│   ├── link.ts      # Package linking
│   ├── unlink.ts    # Package unlinking
│   ├── tree.ts      # Tree traversal
│   ├── updates.ts   # Dependency updates
│   └── versions.ts  # Version management
├── util/
│   ├── npmOptimizations.ts
│   └── performanceTracker.ts
└── index.ts
```

