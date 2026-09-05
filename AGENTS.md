# Repository Guidelines

## Authority and Product Direction

This file is the repository-wide development guide. Explicit user requirements take precedence. `DESIGN.md` is authoritative only for active visual tokens and component styling. Files under `docs/design-archive/` and dated review documents are historical context, not current implementation requirements.

Sirius is a macOS-first third-party 115 client, not a standalone player. File browsing, management, transfer, search, and account workflows form the core. Video playback is an existing content mode; AI-assisted organization, comics, and albums are additional modes built on the same 115 file model. Do not add nonfunctional navigation or placeholder controls for planned modes.

The application intentionally requires a 115 login before use. Its client identity and fixed PKCE behavior follow StarVault compatibility and must not be changed without an explicit product decision.

## Project Structure

- `src/App.tsx` coordinates navigation and cross-feature state.
- `src/components/` contains React UI; `src/domain/` contains shared models; `src/services/` owns all frontend-to-Tauri invocation wrappers.
- `src/assets/` stores bundled artwork and static resources.
- `src-tauri/src/lib.rs` defines commands and native window lifecycle.
- `src-tauri/src/cloud115.rs` owns 115 authentication, files, playback sources, recycle-bin operations, and uploads.
- `src-tauri/src/library.rs` owns SQLite schema, migrations, settings, tasks, and progress.
- `src-tauri/src/playback.rs` owns libmpv and the OpenGL rendering worker.
- `src-tauri/build.rs` packages macOS libmpv dependencies.

Never edit generated output in `dist/`, `node_modules/`, or `src-tauri/target/`.

## Architecture Invariants

- React is the presentation and orchestration layer. Provider credentials, privileged file operations, persistence, and native playback remain in Rust.
- Keep 115 and AI-provider secrets in Rust and the macOS Keychain. Never expose them to React, logs, fixtures, screenshots, or commits.
- Access SQLite only through `LibraryRepository`. Migrations must be idempotent and must not overwrite existing user data.
- Keep Tauri calls behind typed services in `src/services/`; components must not call `invoke` directly.
- The playback chain remains `115 identifier → source resolver → PlaybackSource → PlaybackService → PlaybackManager`. libmpv, CGL/OpenGL context, and RenderContext must stay on one dedicated worker thread. Commands require explicit responses, timeouts, and cleanup on partial failure.
- AI file organization must follow `analyze → preview plan → explicit user confirmation → deterministic execution → result report`. The model cannot authorize its own writes. Rename, move, and delete policy must be enforced in Rust; destructive actions should use recycle/undo semantics where available.
- Comics and albums must reuse provider metadata and introduce bounded thumbnail/index caches. Establish large-directory performance limits before enabling automatic indexing.

## Build and Development Commands

Prerequisites are Node.js 20+, Rust stable, and Homebrew `mpv` plus `pkgconf`.

- `npm install` installs frontend and Tauri dependencies.
- `npm run dev` starts Vite only.
- `npm run tauri dev` starts the complete desktop application.
- `npm run build` type-checks and bundles the frontend.
- `cargo check --manifest-path src-tauri/Cargo.toml` checks Rust compilation.
- `cargo test --manifest-path src-tauri/Cargo.toml` runs Rust tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` checks formatting.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` rejects warnings.
- `npm run tauri build -- --debug` creates the macOS bundle.

Apple Silicon uses `/opt/homebrew/opt/mpv/lib`; Intel uses `/usr/local/opt/mpv/lib`. For another location, set `MPV_LIB_DIR=/absolute/path/to/mpv/lib`. Homebrew is a build-time source only: packaged applications must load non-system dylibs from `Contents/Frameworks`, contain no Homebrew absolute install names, and keep rewritten dylibs validly signed. Release builds additionally require Developer ID signing, notarization, and third-party license materials.

## Coding Style and Error Handling

Use two-space indentation in TypeScript/TSX. Use `PascalCase` for components and exported types, and `camelCase` for variables and functions. Follow Rust conventions (`snake_case` functions, `PascalCase` types) and `rustfmt` output. Preserve existing Chinese user-facing copy and comment style.

Prefer existing helpers and least-change patches. Validate nulls, empty collections, invalid paths, timeouts, and network failures. Return actionable errors. Never silently swallow exceptions, invent successful fallback data, or bypass a failing path with defaults.

## Visual and Interaction Standards

- **Icons:** Use Lucide icons exclusively through a shared React wrapper so size, stroke width, alignment, and accessibility remain consistent. Emoji are forbidden throughout the interface, including buttons, labels, empty states, status indicators, notifications, and decorative content.
- **Quality bar:** Treat Awwwards, FWA, and CSS Design Awards “Site of the Day” work as the minimum visual benchmark. Every shipped screen must demonstrate deliberate art direction, precise typography, disciplined spacing, polished responsive behavior, and production-quality details; generic template or default dashboard aesthetics are unacceptable.
- **Creative freedom:** Treat the application surface as an interactive art canvas rather than a conventional layout grid. Explore asymmetric composition, controlled overlap, experimental editorial typography, dramatic scale, spatial transitions, and fluid physics-based motion. Favor distinctive visual concepts over familiar card stacks while preserving clear hierarchy, keyboard access, and task completion.
- **Immersive execution:** Build each experience as one coherent composition of code, advanced rendering logic, motion, and high-quality imagery. Visual assets must contribute to the same narrative and material system instead of acting as decoration. Transitions should feel continuous across states, and motion must remain performant and provide a reduced-motion path.

## Testing and Acceptance

Add descriptive `snake_case` Rust tests beside changed modules. Cover validation, persistence, migration compatibility, pagination races, and resource cleanup. Live 115 tests are `#[ignore]`; run them only with an explicitly authorized test account because some mutate remote data.

There is no frontend test runner yet. Every UI change must pass `npm run build` and include manual verification notes. Playback changes require open/control/destroy regression checks. Bundle changes require an actual `.app` launch and inspection that neither the executable nor bundled dylibs reference `/opt/homebrew` or `/usr/local`.

## Implementation Order

1. Complete core 115 file management and batch operations.
2. Add the reviewed AI organization workflow and provider boundary.
3. Add comics recognition, grouping, reading progress, and reader mode.
4. Add photo indexing, thumbnails, timeline, and album mode.
5. Continue media scraping, long-playback, and lifecycle hardening.
6. Complete release signing, licensing, and notarization.

## Commits and Pull Requests

This workspace snapshot has no Git history. Use Conventional Commit subjects such as `fix(playback): release worker after open failure`. Keep commits focused. Pull requests must explain behavior changes, list verification commands, link relevant issues, and include screenshots for UI work. Explicitly call out database migrations, permissions, CSP, remote mutations, or bundled-library changes.
