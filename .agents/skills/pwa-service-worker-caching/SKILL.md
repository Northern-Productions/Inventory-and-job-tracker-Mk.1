---
name: pwa-service-worker-caching
description: Improve PWA caching and update behavior. Use when configuring service workers, caching strategies, or fixing stale asset / update issues.
---

# PWA Service Worker Caching Skill

## Caching strategy
- App shell: precache (HTML/CSS/JS)
- API/data: runtime caching with clear versioning rules
- Images: cache-first with size limits

## Update behavior
- Detect new SW, prompt user to refresh
- Avoid “half-updated” states (old SW + new JS)

## What to output when invoked
- Recommended caching strategy for the project’s stack
- Update flow (prompt + reload)
- Common pitfalls checklist
