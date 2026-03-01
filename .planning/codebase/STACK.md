# Technology Stack

**Analysis Date:** 2026-03-01

## Languages

**Primary:**
- TypeScript 5.9.x - All source code (`src/` and `media/`)

**Secondary:**
- JavaScript (CJS) - Build config (`webpack.config.js`), test shim (`test/unit/vscode-shim.js`), scripts (`scripts/`)
- CSS - Webview styles (`media/styles.css`)

## Runtime

**Environment:**
- Node.js v22+ (required for iFlow CLI subprocess; extension host runs in VS Code's bundled Electron Node)
- Browser (sandboxed iframe) - Webview bundle (`dist/webview.js`) targets `web` platform

**Package Manager:**
- npm (lockfile: `package-lock.json` present)

## Frameworks

**Core:**
- VS Code Extension API (`vscode` ^1.82.0) - Extension host surface (commands, webview panels, sidebar, SecretStorage, Memento)
- No frontend framework - Webview is vanilla TypeScript + DOM manipulation

**Testing:**
- Mocha ^11.7.4 - Test runner with `--ui tdd` style
- c8 ^9.1.0 - Coverage reporter (text + json-summary)
- `@vscode/test-cli` ^0.0.11 + `@vscode/test-electron` ^2.5.2 - Integration test harness (for VS Code extension context)

**Build/Dev:**
- Webpack 5.104.x - Dual-bundle compilation (`extensionConfig` → `dist/extension.js`, `webviewConfig` → `dist/webview.js`)
- ts-loader ^9.5.4 - TypeScript loader for Webpack
- ESLint ^9.39.2 + `typescript-eslint` ^8.52.0 - Linting

## Key Dependencies

**Critical:**
- `ws` ^8.18.0 - WebSocket client for ACP transport (`src/acpTransport.ts`). Only runtime dependency.

**Dev / Build Infrastructure:**
- `@types/ws` ^8.5.13 - TypeScript types for `ws`
- `@types/node` 22.x - Node.js built-in typings
- `@types/vscode` ^1.82.0 - VS Code API typings
- `@types/mocha` ^10.0.10 - Mocha test typings

## Configuration

**TypeScript (Extension Host):**
- `tsconfig.json` - `module: Node16`, `target: ES2022`, `strict: true`, outputs to `out/`

**TypeScript (Webview):**
- `tsconfig.webview.json` - `module: ES2022`, `target: ES2022`, `lib: [ES2022, DOM]`, `moduleResolution: bundler`, outputs to `out/media/`

**Build:**
- `webpack.config.js` - Two configs exported: Node target (extension) and web target (webview). Production build uses `--mode production --devtool hidden-source-map`

**Linting:**
- `eslint.config.mjs` - `typescript-eslint` plugin; rules: `@typescript-eslint/naming-convention` (import format), `curly`, `eqeqeq`, `no-throw-literal`, `semi`

**Extension:**
- VS Code configuration namespace `iflow.*` (declared in `package.json` `contributes.configuration`)
- Key config properties: `iflow.nodePath`, `iflow.baseUrl`, `iflow.oauthClientId`, `iflow.port` (default 8090), `iflow.timeout`, `iflow.enableCliStream`, `iflow.debugLogging`

## Platform Requirements

**Development:**
- Node.js v22+ for running iFlow CLI subprocess
- VS Code ^1.82.0 as the extension host

**Production:**
- Distributed as `.vsix` package (built with `vsce`/`vscode:prepublish` script)
- Bundled entry points: `dist/extension.js` (CJS, Node16) and `dist/webview.js` (ESM/web)
- Cross-platform: Windows (`taskkill` for process termination), macOS, Linux

---

*Stack analysis: 2026-03-01*
