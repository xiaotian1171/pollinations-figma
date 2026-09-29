# Changelog

## 1.0.0 — 2026-09-29

First release.

- Generate images from a prompt with any model from the live Pollinations image model list.
- Fill the selected frame, shape or text layer with a generated image (`FILL`, `FIT`, `CROP`, `TILE`).
- Edit an image that is already filling a layer through `POST /v1/images/edits`.
- Sign in with the Pollinations device flow, or paste an API key; both are kept in Figma's `clientStorage`.
- Retries with backoff for rate limits, server errors and connection failures, with the error kind explained in
  the UI.
- 166 offline checks and an opt-in live check suite.
