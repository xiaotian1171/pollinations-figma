# Pollinations for Figma

Generate and edit images with [Pollinations](https://pollinations.ai) inside Figma, paying with your own Pollen.
Write a prompt, pick any model from the live model list, and drop the result straight into the canvas — as a new
layer, as the fill of the frame you have selected, or as an edit of an image already on the canvas.

```
prompt:  a wooden watermill above a quiet river, morning light
model:   tongyi-mai/z-image-turbo   (loaded live, 77 image models at the time of writing)
size:    1024 x 1024                (or the size of the selected frame)
target:  new layer / fill selection / edit selected image
```

## What it does

| Action | What happens |
| --- | --- |
| **Generate** | Sends the prompt to `gen.pollinations.ai/image/{prompt}` and places the returned image. With a selection it becomes a rectangle on top of nothing — a new layer next to your selection; with nothing selected it lands in the middle of the viewport. |
| **Fill selection** | Puts the generated image in the fills of every selected frame, shape or text layer, with `FILL`, `FIT`, `CROP` or `TILE` scaling. The layer keeps its size, corner radius and effects. |
| **Edit selected image** | Takes the image already filling the selected layer, sends it to `POST /v1/images/edits` with your prompt, and places the result as a new layer. The original is left untouched. |
| **Reload** (model list) | Pulls `GET /image/models` and `GET /text/models`, so the dropdown is the live catalogue, never a hard-coded list. |
| **Sign in with a code** | Runs the Pollinations device flow: the plugin shows a code, you type it in the browser, and the key lands in Figma's `clientStorage`. You can also paste an API key by hand. |

Everything the plugin does is visible in the UI: the prompt, the model, the size, the seed, and the status line
that reports what Pollinations answered.

## Requirements and disclosures

- **You need a Pollinations account with Pollen.** Anonymous requests to the image route answer `401` (measured,
  see the tests below), so the plugin expects a key. Keys are created at
  [enter.pollinations.ai/keys](https://enter.pollinations.ai/keys).
- **Network use.** The plugin talks to exactly two hosts, declared in `manifest.json`
  (`networkAccess.allowedDomains`): `https://gen.pollinations.ai` for models, images and edits, and
  `https://enter.pollinations.ai` for the device-flow sign-in. It calls no other service.
- **Where your key lives.** In this Figma client only: `figma.clientStorage` under `pollinations.settings`, written
  by the plugin sandbox. The key is sent to Pollinations as an `Authorization: Bearer` header and to nobody else.
- **No telemetry.** Nothing is reported anywhere; the only outbound requests are the two hosts above.
- **The plugin's UI iframe makes the HTTP calls**, because that is a normal browser context with `fetch`. The
  plugin sandbox only reads the selection and writes layers. That is also why the UI is one self-contained HTML
  file rather than a built React app.
- **License:** MIT.

## Install

The plugin is not in the Figma Community directory yet — see *Publishing* below. Until then, load it locally with
Figma's development import:

1. Download this repository somewhere permanent — the `1.0.0` release carries the same files as a zip, or clone
   it. Figma reads the built files from disk, so moving the folder later breaks the plugin.
2. In the **Figma desktop app**, open any design file and choose **Plugins → Development → Import plugin from
   manifest…**
3. Select `manifest.json` in the repository root.
4. Run it from **Plugins → Development → Pollinations**.

`dist/code.js` and `dist/ui.html` are committed, so you do **not** need Node, npm or a build step to use the
plugin. Only do the next section if you want to change it.

### Building from source

```bash
npm install
npm run build     # tsc --noEmit, then esbuild into dist/code.js and dist/ui.html
```

Re-import the manifest (or press **Plugins → Development → Hot reload plugin**) after a build.

## Demo

1. Open the plugin. The footer shows which key state you are in, and the model dropdown fills itself from
   `GET /image/models`.
2. Type `a wooden watermill above a quiet river, morning light`, keep the size preset, press **Generate new
   layer**. A layer named `Pollinations - a wooden watermill above a quiet river, morning light` appears next to
   the viewport centre and is selected.
3. Select any frame — a hero section, a card, an avatar circle — press **Fill selection**. The image is written
   into that layer's fills with `FILL` scaling; the frame keeps its size and corner radius.
4. With that same layer still selected, write `make it snow` and press **Edit selected image**. The result is
   placed as a new layer; the original is unchanged.
5. Open **More options**, change the seed, and press **Generate** twice: the same seed gives the same picture
   (verified in the live checks).
6. Open **Sign in and keys → Sign in with a code**, copy the code into the browser page the plugin opens, and the
   key is stored for next time.

## How the pieces fit

```
manifest.json          name, id, api 1.0.0, dynamic-page access, the two allowed domains
src/code.ts            the sandbox: selection, fills, createImage, clientStorage, the UI protocol
src/ui.ts              the iframe: fetch, retries, classification, the device flow, all the controls
src/ui.html            the markup and the theme-aware styles (the built script is inlined at build time)
src/shared/api.ts      pure: request shapes, error kinds, parsing, base64 (no Figma, no DOM)
src/shared/format.ts   pure: size presets, layer names, placement, scale modes, selection wording
src/shared/messages.ts the message protocol shared by code.ts and ui.ts
tests/run.ts           the offline checks plus the opt-in live checks
```

The two `shared` modules contain no Figma and no DOM calls on purpose: that is what makes them testable in Node
and what keeps the Figma-specific code small enough to read in one sitting.

## Options

| Option | Notes |
| --- | --- |
| Model | Any image model from the live list. The chosen one is remembered. |
| Size | Six presets, or a custom `W`/`H` from 64 to 4096. A single selected layer overrides this: the image is generated at the layer's size. |
| Seed | `-1` means random. Any other value is passed through, so the same seed reproduces the same image. |
| No watermark | Sends `nologo=true`. Pollinations may still return a watermarked image on some models; that is server side. |
| Safe mode | Sends `safe=true`. |
| Scale in layer | How the image sits inside the layer's fills: `FILL` (cover), `FIT` (contain), `CROP`, `TILE`. |
| Model for edits | `kontext` by default, with `flux.2-klein-4b`, `gemini-2.5-flash-image` and `seedream-4.0` — the models that accept `POST /v1/images/edits`. |
| Edit output size | `1024x1024`, `1536x1024`, `1024x1536`, or the server default. |

## Signing in with a code

The plugin uses the Pollinations device flow, the same one the official apps use:

1. Press **Sign in with a code**. The plugin asks `POST https://enter.pollinations.ai/api/device/code` for a code.
2. It shows something like `WAQ4HB9U` and a link to `https://enter.pollinations.ai/device`.
3. You type the code in the browser and approve. The plugin polls `POST /api/device/token` every 5 seconds
   (`authorization_pending` comes back as HTTP 400 — that is the expected answer, not an error) until it gets a
   token, then stores it and shows your account name via `GET /api/device/userinfo`.
4. Press **Sign in with a code** again to cancel while it is polling.

An *app key* (`pk_…`) is optional: pass your own in **Sign in and keys → App key for sign-in** to have the consent
screen show your app's name. Without one, the plugin uses its own app key — a `pk_` is a public client identifier,
which is why it can ship inside a plugin — and Pollinations falls back to naming the redirect host. Your private
key (`sk_…`) is the one that must never be in a page, and the plugin does not put it in one: it stays in
`clientStorage` and is only ever sent to Pollinations as a bearer header.

## Errors you can actually get

| What you see | What it means |
| --- | --- |
| "Pollinations rejected the API key." | `401`/`403`. Sign in again, or paste a fresh key. |
| "This key is out of Pollen." | `402`. Edits and some models cost Pollen. |
| "Pollinations is rate limiting this key." | `429`. Retried twice with backoff before it is shown. |
| "Pollinations rejected the request: …" | `400`/`404`/`422`, with the server's own message, for example `Invalid model or alias`. |
| "Pollinations had a server error." | `5xx`, after retries. |
| "Could not reach Pollinations." | The request never left the machine. |
| "…could not read." | A `200` whose body the plugin could not parse. |

Rate limits, `5xx` and connection failures are retried three times with exponential backoff (0.75s, 1.5s, 3s,
capped at 8s). Everything else is reported immediately, because retrying an auth or balance problem only wastes
your time.

## Tests

```bash
npm run typecheck   # tsc --noEmit against the real @figma/plugin-typings
npm test            # 166 offline checks, no network
npm run test:live   # the same, plus checks against the real API (needs a key)
```

The offline half covers the request builders, the error classification and backoff, response parsing, the model
list (`name` is the id field, `id` is the fallback), the device-flow states, size clamping, layer naming and
placement. The live half is opt-in and uses a real key from `POLLINATIONS_API_KEY` or
`/root/.pollinations/credentials.json`; steps that are extra evidence are reported as notes if this machine cannot
reach the network, instead of failing.

Measured on 2026-09-29 with a real key:

- `GET /image/models` → `200`, 77 models in 0.88s; `GET /text/models` → `200`, 187 models. Both answer
  `access-control-allow-origin: *`, which is what lets the plugin UI call them.
- Generation through the plugin's own request shape → `200 image/jpeg`, 135515 bytes in 1.19s, header `/9j/`.
- The same prompt and seed → the same 135515 bytes.
- `POST /v1/images/edits` with the plugin's JSON body (data URI + `kontext` + `1024x1024`) → `200`, 130136 base64
  characters of image back.
- `POST /api/device/code` → `200` in 0.88s, code `WAQ4HB9U`, interval 5s, expiry 1800s; polling before approval →
  `HTTP 400 authorization_pending`, read as *pending*.
- A bad model name → `HTTP 400 Invalid model or alias: "definitely-not-a-model"`, classified as a bad request with
  the server's message kept.
- An anonymous image request → `HTTP 401`, which is why the plugin asks for a key.

What is **not** verified here: this was built on a headless machine, so the plugin was never run inside the Figma
desktop app. The Figma-side code is type-checked against `@figma/plugin-typings` and the pure logic is tested, but
"it types" is not "I clicked it". Treat the first import as a small experiment: generate one image, fill one
frame, and edit one image before you rely on it.

## Publishing

Figma Community publishing is interactive: it needs a Figma account, the plugin's own `id` from Figma's **Create
new plugin** dialog, and the review form in the desktop app. The `id` in `manifest.json` here is a development id,
which is exactly what the *Import plugin from manifest* flow needs; Figma replaces it with the real one when the
plugin is published. Everything else needed for publishing is in place: MIT license, no telemetry, network use
declared with a reason, and no request outside the two declared domains.

## License

MIT, see [LICENSE](LICENSE).
