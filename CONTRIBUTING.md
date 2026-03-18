# Contributing to neo

Thank you for your interest in contributing to neo! This document provides guidelines for contributing to the project.

## Submitting Issues

Before submitting an issue:

1. Search existing issues to avoid duplicates
2. Use a clear, descriptive title
3. Include relevant details:
   - Steps to reproduce (for bugs)
   - Expected vs actual behavior
   - Node.js version, OS, and neo version
   - Relevant logs or error messages

Use issue templates when available. For security vulnerabilities, please report privately rather than opening a public issue.

## Submitting Pull Requests

1. Fork the repository and create a feature branch from `main`
2. Make your changes following the code style guidelines below
3. Add or update tests for your changes
4. Ensure all checks pass: `pnpm typecheck && pnpm test && pnpm lint`
5. Write a clear PR description explaining the change and motivation
6. Link any related issues

Keep PRs focused on a single change. Large changes should be discussed in an issue first.

## Code Style Guidelines

This project uses automated tooling to enforce consistent style:

- **TypeScript** for all source code
- **Biome** for linting and formatting - run `pnpm lint:fix` before committing
- **Conventional commits** for commit messages: `feat(scope): description`, `fix(scope): description`, etc.

Key conventions:

- Use ES modules (`import`/`export`)
- Prefer explicit types over `any`
- Keep functions focused and small
- Add JSDoc comments for public APIs
- Follow existing patterns in the codebase

## Development Setup

Prerequisites:

- Node.js >= 22
- pnpm
- git >= 2.20
- Claude Code CLI (for testing agent functionality)

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/neo.git
cd neo

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint and auto-fix
pnpm lint:fix
```

The project is a monorepo with packages in `packages/`:

- `@neotx/core` - Orchestration engine
- `@neotx/agents` - Agent definitions and prompts
- `@neotx/cli` - CLI wrapper

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. All contributors are expected to:

- Be respectful and considerate in all interactions
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what is best for the community

Unacceptable behavior includes harassment, trolling, personal attacks, and other conduct that creates a hostile environment. Violations may result in removal from the project.
