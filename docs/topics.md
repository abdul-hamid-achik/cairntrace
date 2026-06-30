---
title: Topics
description: Deep dives on topics that don't fit cleanly under Steps, Verifiers, or Authoring. Each topic is a choice the spec author or runner maintainer has to make.
---

# Topics

A grab-bag of pages on topics that don't fit cleanly under [Steps](/steps), [Verifiers](/verifiers), or [Authoring](/authoring). Each topic page is a deep dive on one thing.

## Available topics

- [Video recording fallback](/video-screenshot-fallback) — proposed: stitch per-step screenshots into a timelapse video when the native recorder is unavailable.
- [Process monitoring](/monitor) — sample the browser process tree with `--monitor`; the `monitor` step and `process` verifier turn "the spec got slow" into an assertable budget.
- [Services lifecycle](/services) — the config-driven docker/seed/tmux environment `cairn run` owns, and when to disable it per environment.

## Authoring a topic page

A topic page is allowed when:

- It is **not** a step kind, verifier, or configuration key. Those have stable homes elsewhere.
- It explains a *choice* the spec author or runner maintainer has to make.
- It has at least one concrete example.

Topic pages are not a place to dump changelog or implementation notes. If you find yourself writing "in version 1.27.0 we changed X," that's a release note, not a topic — put it in `CHANGELOG.md` instead.

## What we don't host here

- Walkthroughs that fit a learning path. Those go in tutorials or videos.
- Per-PR implementation details. Those go in commit messages and changelog.
- Opinion pieces on testing philosophy. Those go in essays.

## See also

- [Overview](/overview) — what cairntrace is
- [Authoring](/authoring) — what makes a contract survive
