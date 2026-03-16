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

### tree publish lockfile behavior

`kodrdriv tree publish` shells out to `kodrdriv publish` per package, so lockfile handling is inherited from `publish.lockfilePolicy`.

- `ignore` (default): each package must keep `package-lock.json` untracked and ignored.
- `commit`: each package must keep `package-lock.json` present, tracked, and not ignored.

Set policy in your config:

```json
{
  "publish": {
    "lockfilePolicy": "ignore"
  }
}
```

Migration guidance:

```bash
# ignore policy
echo "package-lock.json" >> .gitignore
git rm --cached package-lock.json
git commit -m "chore: enforce lockfile ignore policy"
```

```bash
# commit policy
npm install --package-lock-only --no-audit --no-fund
git add package-lock.json
git commit -m "chore: track lockfile"
```

### updates
Update dependencies matching specific scopes using npm-check-updates.

### versions
Manage dependency version patterns across packages.

## Documentation

- [Agentic Guide](./guide/index.md)

## License

Apache-2.0


<!-- Build: 2026-01-15 15:59:12 UTC -->
