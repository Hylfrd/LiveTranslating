---
name: LiveTranslating
description: A quiet Windows interpreter desk for continuous bilingual reading.
colors:
  ink: "#202426"
  ink-muted: "#60686b"
  ink-faint: "#687174"
  surface: "#ffffff"
  surface-soft: "#f4f6f6"
  surface-active: "#e7f2f0"
  rule: "#dfe3e3"
  rule-strong: "#cbd1d2"
  listening-teal: "#087f78"
  listening-teal-dark: "#076760"
  listening-teal-light: "#17a099"
  error-red: "#b93734"
  warning-amber: "#8c6517"
  focus-blue: "#0b70c9"
  progress-blue: "#4f8ccb"
  control-hover: "#9da7a8"
  compact-surface: "rgb(226 229 231 / 92%)"
typography:
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.72
    letterSpacing: "0"
  translation:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "22px"
    fontWeight: 620
    lineHeight: 1.62
    letterSpacing: "0"
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0"
  compact:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0"
rounded:
  meter: "1px"
  compact: "4px"
  control: "5px"
  feedback: "6px"
  surface: "7px"
  status: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.listening-teal}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    size: "36px"
    height: "36px"
    width: "36px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "37px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 30px 0 10px"
    height: "33px"
---

# Design System: LiveTranslating

## Overview

**Creative North Star: "The Interpreter Desk"**

> A quiet, ruled Windows workspace where live translation owns the reading field and operational controls stay compact, factual, and close to native desktop expectations.

The interface uses a fixed navigation rail, a 72px source transport header, an unframed transcript field, and a collapsible archive rail. This structure is established in [App.tsx](src/desktop/renderer/App.tsx) and [styles.css](src/desktop/renderer/styles.css); it is deliberately closer to a working interpreter console than a card dashboard.

The compact window preserves the same hierarchy at smaller scale: subdued source text, strong translated text, and Windows-style controls. Its implementation lives in [OverlayApp.tsx](src/desktop/renderer/OverlayApp.tsx).

**Key Characteristics:**

- White and cool-gray work surfaces with near-black text.
- Listening teal is reserved for active state and primary action.
- Bilingual paragraphs, not isolated translation cards, are the main content unit.
- Each source page owns its transport and archive controls; the two sources never share panel state.
- Borders establish structure; shadows are reserved for transient or detached surfaces.

## Colors

The palette is neutral first, with listening teal, tally red, warning amber, and focus blue used for explicit system meaning. The normative values are declared in the frontmatter and in the `:root` block of [styles.css](src/desktop/renderer/styles.css).

**The Semantic Accent Rule.** Teal means listening, active, or healthy; red means recording or failure; amber means caution; blue is reserved for keyboard focus and connection progress.

**The White Field Rule.** The transcript and settings reading surfaces remain white. Cool gray separates navigation and compact-window material without turning sections into floating cards.

## Typography

The application uses the Windows-native Segoe UI Variable stack, with Microsoft YaHei UI for Chinese fallback, as defined in [styles.css](src/desktop/renderer/styles.css). Letter spacing remains zero.

- Titles use 14-16px at weight 700.
- Labels and metadata never fall below 12px.
- Source paragraphs use 14px with a 1.72 line height and muted ink.
- Main translations use 22px at weight 620 with a 1.62 line height.
- Compact latest translations use 24px at weight 650.

**The Translation Leads Rule.** Source text remains readable but subordinate; translated text receives the strongest weight and scale on every subtitle surface.

## Layout

The large window is a two-column grid: a 224px sidebar and a fluid content field. Source pages divide the fluid field into a transcript and a 300px archive rail, which can collapse to 48px. At 1040px the sidebar contracts to 190px and the archive rail to 270px; at 760px navigation becomes a 72px icon rail. These breakpoints and dimensions are defined in [styles.css](src/desktop/renderer/styles.css).

Each source owns a separate page, session lifecycle, subtitle flow, and archive panel. The 72px header contains identity, device, level, latency, dropped frames, and play/pause/stop transport. Paragraph content is centered to 820px with a maximum text measure of 74 characters. Settings use one unframed 960px sheet with ruled sections.

The compact surface is designed for a 760x320 window. Its 34px custom title bar remains fixed above a scrolling subtitle stack that keeps the latest three entries at the bottom.

## Elevation & Depth

The large application is flat by default. One-pixel rules and tonal changes establish hierarchy. Shadows appear only on detached feedback and the compact window, as defined in [styles.css](src/desktop/renderer/styles.css): the compact shell uses `0 12px 34px rgb(25 30 34 / 20%)`, while Toasts use a warmer error shadow.

**The Flat Workspace Rule.** Persistent page sections never use decorative shadows. Elevation communicates detachment or temporary feedback, not importance.

## Shapes

Controls use restrained 5px corners, small identity surfaces use 7px corners, and switches/status dots use fully rounded geometry. The shape vocabulary is visible in [ui.tsx](src/desktop/renderer/ui.tsx) and [styles.css](src/desktop/renderer/styles.css). There are no nested cards and no pill-shaped text commands.

## Components

Buttons and fields use stable heights so status changes do not shift layout. The 36px play command uses listening teal; pause and stop replace it without resizing the header. Secondary commands stay white with a cool rule. Icon-only controls use Lucide icons and always expose `aria-label` and `title` through [ui.tsx](src/desktop/renderer/ui.tsx).

Navigation is a dense vertical list with a dark active row, muted inactive rows, and one 7px semantic status dot per source. Toggles use a 38x22px track, a 16px white thumb, and semantic `role="switch"` state.

Transcript paragraphs are unframed. Timestamp and review state form a 12px metadata row, followed by muted source text and the larger translation. Toasts are the only in-app error prompt and leave via transform and opacity without reflowing the page.

The source archive rail is a full-height utility surface rather than a floating card. It provides one filename field, current session state, three file outcomes, recent archive metadata, and three export commands; collapsing it leaves a 48px reopen rail.

## Do's and Don'ts

### Do

- **Do** keep computer audio and microphone content on independent pages.
- **Do** group committed sentences into continuous bilingual paragraphs.
- **Do** keep play/pause/stop and archive state independent for each source page.
- **Do** keep operational metadata at 12px or larger and use tabular numerals for time and latency.
- **Do** use Lucide icons, visible keyboard focus, high-contrast states, and reduced-motion fallbacks.

### Don't

- **Don't** turn the source archive rail into a dashboard or nested card grid.
- **Don't** split the transcript into "current" and "history" visual tiers.
- **Don't** fade older compact subtitles with parent opacity.
- **Don't** use accent colors without a capture, health, recording, warning, error, or focus meaning.

### Per-page checklist

- [ ] One active source page fills the content surface; the other source is reachable from the sidebar.
- [ ] Translation remains the largest content text and wraps without overlap.
- [ ] The source header shows only play while idle, then pause/resume and stop while active.
- [ ] The current source's archive rail can collapse and reopen without resizing its controls.
- [ ] Settings remain a single ruled sheet without a right rail.
- [ ] All controls have hover, disabled, and focus-visible states.
- [ ] Motion is disabled or shortened by the existing `prefers-reduced-motion` rule.
