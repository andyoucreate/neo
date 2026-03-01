# Voltaire Network — Agent Rules

All agents in this system MUST follow these rules. They are inherited from the project owner's conventions.

## Language

- Respond in French to humans. Generate all code, comments, and commits in English.

## Core Principles

- **DRY**: Extract repeated logic into reusable functions/modules. Eliminate all code duplication.
- **YAGNI**: Only implement what's needed NOW. No speculative features or premature abstractions.
- **No Band-Aid Solutions**: Always address root causes, never apply quick fixes that create technical debt.
- **Elegant code**: Favor simplicity and clarity over cleverness.

## TypeScript

- `function` for declarations, arrow functions for callbacks
- Strict mode always, prefer `unknown` over `any`
- Imports: use `@/` path aliases when available
- IMPORTANT: Always adapt to the existing project conventions if they differ

## Naming

- Files: `kebab-case.ts` (e.g., `user-profile.tsx`, `api-client.ts`)
- Variables & Functions: `camelCase` (e.g., `userName`, `fetchUserData`)
- Components: `PascalCase` (e.g., `UserProfile`, `NavBar`)
- Constants: `UPPER_CASE`
- Types: `PascalCase`
- Tables: `kebab-case`

## Architecture & Structure

- Modular structure: organize code by feature/domain, not by type
- Keep modules focused and independent
- Group related files together (component + styles + tests + types)

## React

- One component per file: NEVER put multiple components in the same file
- Prefer event handlers and derived state over `useEffect`
- Use React Query when available for data fetching instead of `useEffect`
- Extract custom hooks for reusable logic
- Keep components under 200 lines
- No inline styles (except dynamic values), no hard-coded colors

## Tools

- Package manager: pnpm
- Tests: vitest
- Run tests after changes

## Git

- Conventional commits: `feat(scope): msg`, `fix:`, `refactor:`, `chore:`
- Branch naming: `feat/`, `fix/`, `chore/` prefix

## Working Process (Critical)

1. ALWAYS read files before editing — understand current code structure
2. Preserve formatting: maintain exact indentation (tabs/spaces)
3. One task at a time: complete one task fully before moving to the next
4. Verify changes: run tests and build after changes
5. ONLY mark tasks as completed when FULLY accomplished and validated
6. Identify ROOT CAUSE before proposing solutions
7. Refactor existing code rather than adding workarounds
8. Check if existing code can be reused or refactored first
