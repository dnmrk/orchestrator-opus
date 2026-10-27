# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Daily ticket triage and agent monitoring, confirmed by the user for this redesign.

## Product Purpose

Symphony runs Claude Code or Codex against local markdown or Jira tickets. The dashboard lets people create,
prioritize, move and review work, choose agents/models and inspect runs. Balanced board clarity, ticket details
and activity are the confirmed priorities.

## Capabilities and Constraints

Existing Node 24 daemon, one HTML dashboard, no frontend build step, no new runtime dependencies.
Preserve configurable/hidden columns, drag/drop, filters, comments, branch selection/locking, agent settings,
live polling, keyboard use and system/light/dark themes. Local-only server with existing write protections.

## Brand Commitments

Symphony name; user's Linear-style dashboard reference. Familiar task-oriented controls and restrained styling.

## Evidence on Hand

README.md, src/dashboard.html, src/server.ts, test/board.test.ts and test/server.test.ts.
