# PRD: [Feature Name]

> **Status**: Draft | In Review | Approved | In Progress | Completed
> **Author**: [Your Name]
> **Created**: YYYY-MM-DD
> **Last Updated**: YYYY-MM-DD

---

## Overview

### Problem Statement

Describe the problem you're solving. Be specific about the pain points.

- What is broken or missing today?
- Who experiences this problem?
- What is the impact (time wasted, revenue lost, user frustration)?

### Proposed Solution

One paragraph summary of what you're building. Keep it high-level — details come later.

### Success Metrics

How will you know this feature succeeded?

| Metric | Current | Target | Measurement Method |
|--------|---------|--------|-------------------|
| Example: Task completion time | 5 min | 2 min | Analytics dashboard |
| Example: User adoption rate | 0% | 80% | Weekly active users |

---

## Context

### Background

Why is this problem worth solving now? Include relevant context:

- Market trends or competitive pressure
- User feedback or support tickets
- Technical debt or architectural constraints
- Strategic initiatives this supports

### Prior Art

What solutions already exist (internal or external)? What can we learn from them?

| Solution | Pros | Cons |
|----------|------|------|
| Competitor A | Fast, simple | Missing X feature |
| Internal workaround | Familiar | Manual, error-prone |

---

## Requirements

### User Stories

```
As a [persona],
I want [capability],
so that [benefit].
```

#### Must Have (P0)

1. **US-01**: As a developer, I want [X] so that [Y].
2. **US-02**: As an admin, I want [X] so that [Y].

#### Should Have (P1)

3. **US-03**: As a user, I want [X] so that [Y].

#### Nice to Have (P2)

4. **US-04**: As a power user, I want [X] so that [Y].

### Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|----|-------------|----------|---------------------|
| FR-01 | System shall do X | P0 | Given A, when B, then C |
| FR-02 | System shall support Y | P1 | User can perform action Z |

### Non-Functional Requirements

| ID | Requirement | Target | Measurement |
|----|-------------|--------|-------------|
| NFR-01 | Response time | < 200ms p95 | APM monitoring |
| NFR-02 | Availability | 99.9% | Uptime tracking |
| NFR-03 | Security | SOC 2 compliant | Annual audit |

---

## Design

### User Flow

Describe the step-by-step user journey:

1. User navigates to X
2. User clicks Y
3. System displays Z
4. User completes action

### Wireframes / Mockups

_Link to Figma, screenshots, or describe the UI._

### API Design

If applicable, outline the API surface:

```
POST /api/v1/resource
Request: { field: "value" }
Response: { id: "uuid", status: "created" }
```

### Data Model

Key entities and their relationships:

```
Entity: ResourceName
- id: UUID (PK)
- name: string
- created_at: timestamp
- owner_id: UUID (FK -> Users)
```

---

## Technical Approach

### Architecture

High-level technical approach. Include:

- Components affected
- New services or modules
- Integration points
- Data flow

### Dependencies

| Dependency | Type | Risk | Mitigation |
|------------|------|------|------------|
| Service X | External API | Medium | Implement fallback |
| Team Y | Cross-team | Low | Align on timeline |

### Security Considerations

- Authentication/authorization changes
- Data privacy implications
- Input validation requirements

### Performance Considerations

- Expected load
- Caching strategy
- Database query patterns

---

## Rollout Plan

### Phases

| Phase | Scope | Duration | Success Criteria |
|-------|-------|----------|------------------|
| Alpha | Internal team | 1 week | No critical bugs |
| Beta | 10% users | 2 weeks | Positive feedback |
| GA | All users | - | Metrics achieved |

### Feature Flags

- `feature_name_enabled`: Controls visibility
- `feature_name_v2`: A/B test variant

### Rollback Plan

If critical issues arise:

1. Disable feature flag
2. Notify affected users
3. Investigate root cause
4. Fix and re-deploy

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Technical complexity underestimated | Medium | High | Spike before committing |
| User adoption lower than expected | Low | Medium | User research upfront |
| Dependency delays | Medium | Medium | Parallel workstreams |

---

## Timeline

| Milestone | Target Date | Owner |
|-----------|-------------|-------|
| PRD approved | Week 1 | PM |
| Design complete | Week 2 | Design |
| Development start | Week 3 | Eng |
| Alpha release | Week 5 | Eng |
| Beta release | Week 7 | Eng |
| GA release | Week 9 | PM |

---

## Open Questions

- [ ] Question 1: What is the expected scale?
- [ ] Question 2: How does this interact with feature Y?
- [ ] Question 3: What are the compliance requirements?

---

## Appendix

### Glossary

| Term | Definition |
|------|------------|
| Term A | Definition of term A |
| Term B | Definition of term B |

### References

- [Link to user research]()
- [Link to technical RFC]()
- [Link to design specs]()

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| YYYY-MM-DD | Name | Initial draft |
