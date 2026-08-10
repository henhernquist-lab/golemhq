# enry lite — Mobile Architecture

## Overview

enry lite is the stripped-down mobile companion for enry.agent, living at the `/m` route inside the main Next.js app. It shares the same auth, backend, and Supabase as the desktop app — it's the same product, just distilled for one-handed phone use.

## What's on lite vs. desktop-only

### Included on mobile

| Feature | Route | Notes |
|---|---|---|
| **Chat** | `/m/chat` | SSE streaming via existing `/api/chat`. Model picker as bottom sheet. Voice input records locally and is transcribed by Whisper on the host (`/api/voice/transcribe`) — it needs that host reachable, and the mic says so when it is not. Conversation history as bottom sheet. |
| **Inbox** | `/m/inbox` | Alert/notification feed. Expandable items with deep-links to desktop. Pull-to-refresh. |
| **Status** | `/m/status` | Cron job health — one card per job, green/yellow/red, expand for last-run output, "Run now" per job. |
| **Tools** | `/m/tools` | Web search (Tavily), memory search (pgvector recall), GitHub quick-check. "More tools" sheet lists desktop-only tools. |

### Excluded from mobile

- Live Terminal and coding-agent diff-preview
- Enry Drive / Cruise (full coding agent interface)
- Cross-tool Synthesis Layer
- Chief of Staff daily briefing
- The Aperture (daily question)
- The Root Cause (failure investigation)
- Ghost Mode (past-self conversations)
- Tool configuration
- Migration/DB management
- Repo file tree browsing

If a user needs these, each excluded tool shows an "Open on desktop" note rather than a broken cramped version.

## Architecture decisions

- **Same Next.js app.** No separate deploy, no duplicate auth. `/m` is just another route group.
- **Same API routes.** Chat reuses `/api/chat` directly — same SSE streaming, same tools, same focus modes.
- **NextAuth v5 session.** `/m/layout.tsx` calls `auth()` and redirects to `/login` if unauthenticated.
- **dvh units everywhere.** `h-dvh` instead of `h-screen` so the mobile keyboard doesn't push content offscreen.
- **safe-area-inset.** Bottom tab bar and headers respect `env(safe-area-inset-bottom)` and `env(safe-area-inset-top)` for notched devices.
- **Bottom sheets over modals.** Reusable `BottomSheet` component with spring animation — sheets > dropdowns on mobile.
- **44px minimum tap targets.** Every interactive element meets the Apple HIG minimum.
- **Dark by default.** Same `#080808` base, green `#3a9e60` accent, `Inter` + `IBM Plex Mono` fonts as desktop.

## Component inventory

| Component | Path | Purpose |
|---|---|---|
| `MobileNav` | `src/components/mobile/MobileNav.tsx` | Fixed bottom tab bar — Chat · Inbox · Status · Tools. Supports unread badges. |
| `BottomSheet` | `src/components/mobile/BottomSheet.tsx` | Reusable spring-animated sheet. Accepts `open`, `onClose`, `title`, `children`, `height`. |

## PWA

`public/manifest.json` configures:
- `start_url: "/m"` — opens directly into the mobile experience
- `display: "standalone"` — no browser chrome on iOS home screen
- `theme_color: "#080808"` — matches the dark base

The `/m/layout.tsx` links the manifest and sets `appleWebApp` metadata for iOS.
