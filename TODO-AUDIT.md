# TODO Audit

Generated: 2025-01-15

## Summary

| Category | Count |
|----------|-------|
| TODO     | 1     |
| FIXME    | 0     |
| XXX      | 0     |
| HACK     | 0     |
| **Total**| **1** |

## TODO Comments

### packages/core/src/supervisor/heartbeat.ts

**Line 172:**
```typescript
activeRuns: [], // TODO: read from persisted runs
```

**Context:** The `activeRuns` array in the heartbeat state is currently hardcoded to an empty array. This needs to be populated by reading from persisted run data.
