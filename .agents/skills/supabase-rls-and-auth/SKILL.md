---
name: supabase-rls-and-auth
description: Secure Supabase usage for inventory apps. Use when creating tables, policies (RLS), auth/session handling, or client queries that access inventory data.
---

# Supabase RLS + Auth Skill

## Goals
- Ensure only authorized users can read/write inventory.
- Keep client queries simple and safe.

## Rules of thumb
- Enable RLS on every table that holds user/org data.
- Prefer org/workspace scoping: every row has org_id.
- Use policies that reference auth.uid() and membership tables.

## When writing mutations
- Validate org membership server-side (policy or RPC).
- Write inventory mutations (audit trail) rather than direct stock overwrites when possible.

## What to output when invoked
- Table structure suggestions (orgs, members, roles)
- RLS policies for read/write
- Client query patterns
- Notes for edge functions/RPC where needed
