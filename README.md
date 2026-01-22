# @grunnverk/commands-tree

Tree and dependency management commands for kodrdriv.

## Installation

```bash
npm install @grunnverk/commands-tree
```

## Usage

```typescript
import * as Tree from '@grunnverk/commands-tree';

// Link workspace packages
await Tree.link(config);

// Unlink workspace packages
await Tree.unlink(config);

// Run tree traversal command
await Tree.tree(config);

// Update dependencies
await Tree.updates(config);

// Manage versions
await Tree.versions(config);
```

## Commands

### link
Links workspace packages for local development.

### unlink
Restores registry versions from linked packages.

### tree
Central dependency analysis and tree traversal:
- Custom command mode: `kodrdriv tree --cmd "npm install"`
- Built-in command mode: `kodrdriv tree commit`, `kodrdriv tree publish`
- Supports parallel execution with smart dependency ordering

### updates
Update dependencies matching specific scopes using npm-check-updates.

### versions
Manage dependency version patterns across packages.

## Documentation

- [Agentic Guide](./guide/index.md)

## License

Apache-2.0


<!-- Build: 2026-01-15 15:59:12 UTC -->
