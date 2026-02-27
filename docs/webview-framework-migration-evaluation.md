# Webview Framework Migration Evaluation (S8)

## Scope
- Evaluate whether the current webview renderer should migrate from string-template DOM rendering to a framework runtime.
- Land a minimal migration seam without changing protocol or runtime behavior.

## Current Baseline
- Rendering model: string templates + incremental DOM patching.
- Key modules: `media/main.ts`, `media/appRenderer.ts`, `media/streamingViewUpdater.ts`.
- Existing optimization: frame-based coalescing via `VisualUpdateScheduler`.

## Option Comparison

| Option | Pros | Cons | Fit (Current Codebase) |
| --- | --- | --- | --- |
| Keep current (no framework) | No extra deps, smallest bundle impact, full control over hot paths | Manual state/render wiring cost remains | High |
| React | Mature ecosystem and tooling | Larger runtime/bundle, migration cost is high for existing imperative modules | Medium |
| Preact | React-like model with smaller runtime | Still requires componentization rewrite and state model migration | Medium-High |
| Svelte | Compile-time optimization, less runtime overhead | Toolchain and code style shift; larger rewrite upfront | Medium |
| Lit | Lightweight web components approach | Requires template/DOM ownership model changes and event lifecycle rewrite | Medium |

## Decision
- Short term: **do not perform full framework migration in this phase**.
- Rationale:
  - Current structure already split renderer, binder, and incremental updaters.
  - Streaming path performance work in S7 is still fresh and should be stabilized before a large runtime shift.
  - Framework migration adds dependency and bundling complexity with unclear near-term product gain.

## Landed in S8
- Added `WebviewRenderDriver` abstraction (`media/renderDriver.ts`).
- `media/main.ts` now delegates full render execution through the driver.
- Default driver keeps existing string-template render path (`performFullRender`) unchanged.

## Migration Path (Future Optional)
1. Add a framework-backed driver that implements `WebviewRenderDriver`.
2. Move composer/top-bar/messages into isolated components.
3. Keep `streamingViewUpdater` behavior parity first; optimize after parity tests pass.
4. Switch by config/build flag only after side-by-side acceptance runs.
