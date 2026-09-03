# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: Electron, React, TypeScript, and Vite for Windows desktop windows,
custom window chrome, taskbar integration, and reuse of the existing Node.js
application controller. The existing Ink TUI remains a supported entry point.

## Users

The primary user is a university student watching English-language Finance and
Computer Science lectures on Windows while needing readable Simplified Chinese
translation with domain terminology preserved.

## Product Purpose

LiveTranslating captures Windows system audio or a selected microphone,
transcribes speech locally, translates committed sentences, optionally reviews
them asynchronously, and preserves recordings and structured session output.
Success means translated lecture speech is readable within a few seconds without
interrupting the source application.

## Positioning

One local pipeline presents the same independently processed system and
microphone sources through a full control workspace, a compact subtitle window,
and a terminal interface, while keeping recording, glossary, logs, and delayed
revision state consistent across all surfaces.

## Operating Context

- Windows desktop use alongside lecture video, meetings, or streamed content.
- Frequent scanning of English source text and a larger Chinese translation.
- Finance and CST terminology, numbers, formulas, and named entities matter.
- The compact window may remain open while the main control window is minimized.
- The compact window is a normal taskbar window, not always on top.

## Capabilities and Constraints

- Preserve the existing Node.js backend and Ink TUI.
- Add a large white desktop control window and a compact translucent-gray subtitle window.
- Keep system audio and microphone independently selectable and concurrently usable.
- Expose microphone device, recording, languages, translation model, delayed review,
  glossary reload, source health, recent subtitles, and structured logs.
- The compact window has only an expand control at top left and custom minimize and
  close controls at top right.
- Closing the compact window keeps translation running in the background and leaves
  the main application minimized in the taskbar.
- The compact window is draggable and does not default to always-on-top or click-through.
- Desktop UI language is Simplified Chinese; provider and model identifiers remain English.
- The application must have a recognizable Windows taskbar icon.
- Assumption: the first packaged target is Windows x64.

## Brand Commitments

- Product name: LiveTranslating.
- Quiet, work-focused behavior suitable beside dense lecture material.
- Main workspace uses a white ground; compact subtitles use a slightly translucent gray ground.
- No existing logo or brand artwork is authoritative.

## Evidence on Hand

- Existing backend and TUI under `src/`.
- Real system-loopback, microphone, ASR, translation, recording, and shutdown tests.
- Lecture benchmark artifacts under `data/benchmarks/lecture-20260902/`.
- A user-provided Windows icon-area screenshot used only as contextual evidence for
  taskbar icon legibility, not as a visual identity reference.

## Product Principles

- Translation remains the dominant content; controls recede until needed.
- Source, translation, revision, recording, and error states are never conflated.
- Compact mode stays readable over other applications without behaving like a notification.
- The full workspace favors fast repeated operation over decorative dashboard patterns.
- Every window action has a predictable Windows desktop consequence.

## Accessibility & Inclusion

- Keyboard operation, visible focus, reduced-motion support, and high text contrast are required.
- Dynamic source and translation text must wrap without overlapping controls at supported window sizes.
