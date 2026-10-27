# Image Content Replies Implementation Plan

**Goal:** Make image replies explicitly grounded in visible contents and accompanying questions, with truthful failure messages.

**Architecture:** Reuse OneBot → SocialEngine → DSH native attachment admission → text delivery. Add a focused image reply context builder and actionable image-unavailable placeholders, preserving existing image limits and integrity checks.

**Tech Stack:** Existing JavaScript ES modules, node:test, local Reader HTTP API. Use bundled Node 24; system Node 16 does not meet package engines.

## Tasks

- [x] Add `scripts/test-image-replies.mjs`: feed normalized pure-image and captioned multi-image events through SocialEngine; assert original image references, source mapping, reply instructions and sent reply. Verify text-only turns do not receive image guidance and library candidates are not attributed to users.
- [x] Add failing cases to `scripts/test-image-input.mjs`: unsupported model, missing local copy and timeout must yield actionable, sanitized placeholders while preserving other readable images.
- [x] Run `node --test scripts/test-image-replies.mjs scripts/test-image-input.mjs`; verify the new assertions fail for absent reply guidance.
- [x] Implement `components/qq-bridge/src/core/image-reply-context.js` and call it from `social-engine.js` after finalizing attachment order. Map images to source message positions and distinguish library previews. Do not change group wake rules or auto-read arbitrary paths.
- [x] Update `image-input.mjs` unavailable placeholders: distinguish unsupported model and local/timeout failures, tell the model to disclose inability, continue with available text/images, and never guess.
- [x] Extend native session tests to assert image guidance and native image admission arrive together, and a read failure still produces a reply without blocking the next text turn.
- [x] Document prerequisites and manual verification in `docs/IMAGE_REPLIES.md`, link from README.
- [x] Run focused image/media/native/prompt tests, then full `node --test scripts/test-*.mjs`; inspect `git diff --check` and final diff. Record any unrelated failures separately.


## Verification result

- Node.js 24.22.1; full suite: 291 tests, 290 passed, 0 failed, 1 skipped (NSIS compiler/build dependencies unavailable).
- Focused image/media/native/prompt suite: 74 passed before adding two additional group/library regression cases; both additional cases passed in the full suite.
- Installed locked DSH plugin dependencies with npm ci; created ignored state directory needed by an existing test. Test TEMP/TMP used the long Windows path to avoid pre-existing short-path comparison failures.
- git diff --check passed. Independent read-only code review found no actionable issues.
- Kept source changes on codex/image-content-replies. Real WeChat/DSH vision was not exercised; native model responses in tests are fixtures.
