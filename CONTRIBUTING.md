# Contributing

## Development Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint (auto-fix)
pnpm lint:fix
```

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code change that neither fixes a bug nor adds a feature
- `test` - Adding or updating tests
- `chore` - Maintenance tasks

**Examples:**
```
feat(cli): add --verbose flag to run command
fix(runner): handle session timeout correctly
refactor(core): simplify middleware chain
```

## Branch Naming

Use prefixes that match commit types:

- `feat/` - Feature branches
- `fix/` - Bug fix branches
- `chore/` - Maintenance branches

**Examples:**
```
feat/add-retry-logic
fix/session-timeout
chore/update-dependencies
```
