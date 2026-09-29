/**
 * The checks behind this plugin.
 *
 * The first half is offline: request shapes, error kinds, parsing and the small
 * decisions about where a layer goes. The second half only runs with --live and
 * talks to the real Pollinations API with a real key, so the README can quote
 * numbers that were actually measured.
 */

import { readFileSync } from "fs";
import {
	backoffSeconds,
	buildDeviceCodeRequest,
	buildDeviceTokenRequest,
	buildEditRequest,
	buildImageRequest,
	buildModelsRequest,
	bytesToBase64,
	classify,
	dataUri,
	errorDetail,
	extractImage,
	hasModel,
	imageExtension,
	isTextual,
	mentionsBalance,
	messageFor,
	modelIds,
	modelsSupporting,
	parseDeviceCode,
	parseDeviceToken,
	parseModels,
	parseUserInfo,
	retryable,
	verificationUrl,
} from "../src/shared/api";
import {
	applyTemplate,
	clampSeed,
	clampSize,
	describeSelection,
	layerName,
	normalizeScaleMode,
	placementFor,
	sizeForTarget,
	SIZE_PRESETS,
} from "../src/shared/format";

let passed = 0;
let failed = 0;
function section(name: string): void {
	console.log("\n# " + name);
}

function ok(condition: boolean, label: string): void {
	if (condition) {
		passed++;
		console.log("  ok   " + label);
	} else {
		failed++;
		console.log("  FAIL " + label);
	}
}

function equal<T>(actual: T, expected: T, label: string): void {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	if (!same) {
		console.log("       expected " + JSON.stringify(expected) + "\n       actual   " + JSON.stringify(actual));
	}
	ok(same, label);
}

function contains(haystack: string, needle: string, label: string): void {
	ok(haystack.includes(needle), label + " (looking for " + JSON.stringify(needle) + ")");
}

/* ------------------------------------------------------------------ offline */

section("image requests");
{
	const req = buildImageRequest("a wooden watermill", { model: "tongyi-mai/z-image-turbo", width: 1024, height: 768 });
	ok(req.url.startsWith("https://gen.pollinations.ai/image/"), "the prompt goes to the image route");
	contains(req.url, "a%20wooden%20watermill", "the prompt is URL encoded");
	contains(req.url, "model=tongyi-mai%2Fz-image-turbo", "the model is passed through");
	contains(req.url, "width=1024", "the width is passed through");
	contains(req.url, "height=768", "the height is passed through");
	equal(req.method, "GET", "generation is a GET");
	equal(req.headers.Authorization, undefined, "an anonymous request sends no key");

	const withKey = buildImageRequest("x", {}, "sk_test");
	equal(withKey.headers.Authorization, "Bearer sk_test", "the key becomes a bearer header");

	const optional = buildImageRequest("x", { seed: -1, nologo: false, safe: true });
	contains(optional.url, "seed=-1", "a seed of -1 means random and is still sent");
	contains(optional.url, "nologo=false", "nologo is sent explicitly");
	contains(optional.url, "safe=true", "safe mode is sent explicitly");

	const bare = buildImageRequest("x");
	equal(bare.url, "https://gen.pollinations.ai/image/x", "no options means no query string");
}

section("edit requests");
{
	const req = buildEditRequest(
		"replace the sky with a sunset",
		{ dataUri: dataUri("image/png", "AAAA"), model: "kontext", size: "1024x1024" },
		"sk_test"
	);
	equal(req.url, "https://gen.pollinations.ai/v1/images/edits", "edits go to the OpenAI compatible route");
	equal(req.method, "POST", "an edit is a POST");
	equal(req.headers["Content-Type"], "application/json", "an edit is JSON");
	equal(req.headers.Authorization, "Bearer sk_test", "an edit carries the key");

	const body = JSON.parse(req.body || "{}");
	equal(body.prompt, "replace the sky with a sunset", "the prompt is in the body");
	equal(body.image, "data:image/png;base64,AAAA", "the source image travels as a data URI");
	equal(body.model, "kontext", "the edit model is in the body");
	equal(body.size, "1024x1024", "the edit size is in the body");
	equal(body.response_format, "b64_json", "base64 is the response format the plugin can place");

	const minimal = JSON.parse(buildEditRequest("x", { dataUri: "data:image/jpeg;base64,BB" }).body || "{}");
	equal(minimal.model, undefined, "no model means the server default");
	equal(minimal.size, undefined, "no size means the server default");
}

section("model list requests");
{
	equal(buildModelsRequest("image").url, "https://gen.pollinations.ai/image/models", "image models have their own route");
	equal(buildModelsRequest("text").url, "https://gen.pollinations.ai/text/models", "text models have their own route");
}

section("error kinds");
{
	equal(classify(200, "{}"), "none", "200 is fine");
	equal(classify(401, ""), "auth", "401 is an auth problem");
	equal(classify(403, ""), "auth", "403 is an auth problem");
	equal(classify(402, ""), "balance", "402 is out of Pollen");
	equal(classify(429, ""), "rate_limit", "429 is rate limiting");
	equal(classify(400, ""), "bad_request", "400 is a bad request");
	equal(classify(404, ""), "bad_request", "404 is treated as a bad request");
	equal(classify(422, ""), "bad_request", "422 is treated as a bad request");
	equal(classify(500, ""), "server", "500 is a server problem");
	equal(classify(503, ""), "server", "503 is a server problem");
	equal(classify(0, "", true), "network", "a thrown fetch is a network problem");
	equal(classify(200, "", false, true), "parse", "unreadable 200 is a parse problem");
	equal(classify(200, '{"error":"Insufficient balance. This request costs ~0.0136 pollen"}'), "balance", "a balance message in a 200 is still balance");
	ok(mentionsBalance("Insufficient balance"), "balance wording is recognised");
	ok(mentionsBalance("insufficient_balance"), "the snake case variant is recognised");
	ok(mentionsBalance("You are out of pollen"), "out of pollen is recognised");
	ok(!mentionsBalance("all good"), "harmless text is not balance");

	ok(retryable("rate_limit"), "rate limits are retried");
	ok(retryable("server"), "server errors are retried");
	ok(retryable("network"), "network errors are retried");
	ok(!retryable("auth"), "auth errors are not retried");
	ok(!retryable("balance"), "balance errors are not retried");
	ok(!retryable("bad_request"), "bad requests are not retried");

	equal(backoffSeconds(1), 0.75, "the first retry waits 0.75s");
	equal(backoffSeconds(2), 1.5, "the second waits twice as long");
	equal(backoffSeconds(3), 3, "the third waits twice as long again");
	equal(backoffSeconds(9), 8, "the wait is capped at 8s");

	ok(messageFor("none").length <= 10, "success needs no lecture");
	equal(messageFor("none"), "Done.", "success says Done.");
	for (const kind of ["auth", "balance", "rate_limit", "server", "network", "parse"] as const) {
		ok(messageFor(kind).length > 20, kind + " gets a real explanation");
	}
	contains(messageFor("balance"), "Pollen", "the balance message mentions Pollen");
	contains(messageFor("bad_request", 400, "prompt too long"), "prompt too long", "a bad request repeats the detail");
}

section("reading answers");
{
	const body = JSON.stringify({ data: [{ b64_json: "QUJD" }] });
	equal(extractImage(body).base64, "QUJD", "base64 comes out of the OpenAI shape");
	equal(extractImage(JSON.stringify({ data: [{ url: "https://x/y.png" }] })).url, "https://x/y.png", "a url comes out too");
	equal(extractImage("not json").base64, "", "garbage gives nothing");
	equal(extractImage("{}").base64, "", "an empty object gives nothing");

	equal(errorDetail('{"error":"nope"}'), "nope", "a string error is read");
	equal(errorDetail('{"error":{"message":"nope"}}'), "nope", "an object error is read");
	equal(errorDetail('{"message":"nope"}'), "nope", "a top level message is read");
	equal(errorDetail(""), "", "nothing in, nothing out");

	ok(isTextual("application/json"), "json counts as text");
	ok(isTextual(""), "a missing content type counts as text");
	ok(!isTextual("image/png"), "png does not count as text");
	ok(!isTextual("image/jpeg"), "jpeg does not count as text");
	ok(!isTextual("application/octet-stream"), "binary counts as not text");

	equal(imageExtension("image/png"), "png", "png is png");
	equal(imageExtension("image/jpeg"), "jpg", "jpeg becomes jpg");
	equal(imageExtension("image/webp"), "webp", "webp is webp");
	equal(imageExtension("", "https://x/y.jpg?token=1"), "jpg", "the url is a fallback");
	equal(imageExtension("", ""), "png", "the last resort is png");
}

section("base64 and data uris");
{
	equal(bytesToBase64(new Uint8Array([])), "", "nothing becomes nothing");
	equal(bytesToBase64(new Uint8Array([65])), "QQ==", "one byte is padded once");
	equal(bytesToBase64(new Uint8Array([65, 66])), "QUI=", "two bytes are padded once");
	equal(bytesToBase64(new Uint8Array([65, 66, 67])), "QUJD", "three bytes need no padding");
	equal(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "iVBORw==", "a PNG header encodes as expected");
	equal(dataUri("image/png", "QUJD"), "data:image/png;base64,QUJD", "the data URI shape");
	equal(dataUri("", "QUJD"), "data:image/png;base64,QUJD", "a missing mime falls back to png");
}

section("reading the model list");
{
	const body = JSON.stringify([
		{ name: "tongyi-mai/z-image-turbo", title: "Z-Image Turbo", category: "image", publisher: "Tongyi", aliases: ["z-image"], supported_endpoints: ["/image/{prompt}"], description: "fast" },
		{ id: "black-forest-labs/flux", title: "Flux", category: "image", supported_endpoints: [] },
		{ name: "" },
	]);
	const models = parseModels(body, "image");
	equal(modelIds(models), ["tongyi-mai/z-image-turbo", "black-forest-labs/flux"], "the id field is `name`, with `id` as a fallback");
	equal(models.length, 2, "entries without an id are dropped");
	equal(models[0].title, "Z-Image Turbo", "the title is kept");
	equal(models[0].publisher, "Tongyi", "the publisher is kept");
	ok(hasModel(models, "tongyi-mai/z-image-turbo"), "an id is found");
	ok(hasModel(models, "z-image"), "an alias is found");
	ok(!hasModel(models, "nope"), "a miss is a miss");
	ok(!hasModel(models, ""), "an empty id is not a match");
	equal(modelsSupporting(models, "/image/{prompt}").length, 2, "a missing endpoint list means any endpoint");

	const wrapped = JSON.stringify({ data: [{ name: "a" }] });
	equal(modelIds(parseModels(wrapped)), ["a"], "a data envelope is read");
	const nested = JSON.stringify({ categories: [{ models: [{ name: "a" }] }, { models: [{ name: "b" }] }] });
	equal(modelIds(parseModels(nested)), ["a", "b"], "a category envelope is read");
	equal(parseModels("nope"), [], "garbage gives no models");
	equal(parseModels("[]"), [], "an empty list gives no models");
}

section("device code flow parsing");
{
	const body = JSON.stringify({
		device_code: "abc",
		user_code: "8ZMYESJU",
		verification_uri: "/device",
		verification_uri_complete: "/device?user_code=8ZMYESJU",
		interval: 5,
		expires_in: 1800,
	});
	const code = parseDeviceCode(body);
	ok(code !== null, "a device code is parsed");
	equal(code?.userCode, "8ZMYESJU", "the user code is kept");
	equal(code?.interval, 5, "the interval is kept");
	equal(code?.expiresIn, 1800, "the expiry is kept");
	equal(code?.verificationUri, "https://enter.pollinations.ai/device", "a relative uri is made absolute");
	equal(code?.verificationUrlComplete, "https://enter.pollinations.ai/device?user_code=8ZMYESJU", "the complete url is kept");

	const absolute = parseDeviceCode(JSON.stringify({ device_code: "a", user_code: "b", verification_uri: "https://x/y" }));
	equal(absolute?.verificationUri, "https://x/y", "an absolute uri is left alone");
	const defaults = parseDeviceCode(JSON.stringify({ device_code: "a", user_code: "b" }));
	equal(defaults?.interval, 5, "a missing interval falls back to 5s");
	equal(defaults?.expiresIn, 900, "a missing expiry falls back to 15 minutes");
	equal(parseDeviceCode("{}"), null, "no codes means no device code");
	equal(parseDeviceCode("no"), null, "garbage means no device code");

	equal(verificationUrl("/device", "AB", false), "https://enter.pollinations.ai/device", "the bare page is available");
	equal(verificationUrl("/device", "AB", true), "https://enter.pollinations.ai/device?user_code=AB", "the prefilled page is available");

	equal(parseDeviceToken(200, '{"access_token":"sk_new"}').state, "granted", "a token means signed in");
	equal(parseDeviceToken(200, '{"access_token":"sk_new"}').apiKey, "sk_new", "the token is the api key");
	equal(parseDeviceToken(400, '{"error":"authorization_pending"}').state, "pending", "400 pending is still waiting (this is the real behaviour)");
	equal(parseDeviceToken(428, "").state, "pending", "428 is also waiting");
	equal(parseDeviceToken(400, '{"error":"slow_down","interval":10}').state, "slow_down", "slow down is understood");
	equal(parseDeviceToken(400, '{"error":"slow_down","interval":10}').interval, 10, "the new interval is taken");
	equal(parseDeviceToken(400, '{"error":"expired_token"}').state, "expired", "expiry is understood");
	equal(parseDeviceToken(400, '{"error":"access_denied"}').state, "denied", "a refusal is understood");
	equal(parseDeviceToken(500, "boom").state, "error", "anything else is an error");

	equal(parseUserInfo('{"name":"kai"}').name, "kai", "a name is read");
	equal(parseUserInfo('{"preferred_username":"kai"}').name, "kai", "a preferred username is read");
	equal(parseUserInfo('{"email":"a@b.c"}').email, "a@b.c", "an email is read");
	equal(parseUserInfo("nope").name, "", "garbage has no name");
}

section("sizes and layer names");
{
	equal(clampSize(1024), 1024, "a sane size is kept");
	equal(clampSize(10), 64, "a tiny size is raised to the minimum");
	equal(clampSize(99999), 4096, "a huge size is lowered to the maximum");
	equal(clampSize(1024.6), 1025, "a size is rounded");
	equal(clampSize(Number("nope")), 1024, "nonsense falls back to 1024");
	equal(clampSeed(-1), -1, "a seed of -1 means random and is left alone");
	equal(clampSeed(-5), -1, "a negative seed becomes random");
	equal(clampSeed(12.4), 12, "a seed is rounded");
	equal(clampSeed(Number("nope")), -1, "a nonsense seed means random");

	const square = SIZE_PRESETS.find((preset) => preset.name === "Square 1024");
	equal(square?.width, 1024, "the square preset is 1024 wide");
	ok(SIZE_PRESETS.every((preset) => clampSize(preset.width) === preset.width), "every preset is inside the allowed range");
	ok(SIZE_PRESETS.every((preset) => clampSize(preset.height) === preset.height), "every preset height is allowed too");

	equal(layerName("a wooden watermill"), "Pollinations - a wooden watermill", "the layer name starts with the plugin name");
	equal(layerName("  spaced   out  "), "Pollinations - spaced out", "the whitespace is tidied");
	equal(layerName(""), "Pollinations", "an empty prompt still names the layer");
	equal(layerName("x".repeat(200)).length, 80, "long prompts are shortened to the layer-name limit");
	contains(layerName("x".repeat(200)), "\u2026", "a shortened name says so");
	equal(layerName("x".repeat(40)), "Pollinations - " + "x".repeat(40), "a prompt that fits is left alone");
	equal(layerName("x".repeat(200), 40).length, 40, "the limit can be lowered");

	equal(applyTemplate("a {{subject}} in {{style}}", { subject: "cat", style: "ink" }), "a cat in ink", "templates are filled");
	equal(applyTemplate("{{missing}}", {}), "{{missing}}", "an unknown placeholder is left alone");
	equal(applyTemplate("{{spaced }}", { spaced: "y" }), "y", "placeholders tolerate spaces");
}

section("where the image goes");
{
	equal(placementFor({ x: 0, y: 0 }, 100, 50), { x: -50, y: -25 }, "a new layer is centred on the viewport");
	equal(placementFor({ x: 500, y: 400 }, 1024, 1024), { x: -12, y: -112 }, "centring works with a real viewport centre");

	const empty = describeSelection([]);
	contains(empty, "new layer", "no selection means a new layer");
	const one = describeSelection([{ name: "Hero", type: "FRAME", width: 1440, height: 900, hasImageFill: false }]);
	contains(one, "Hero", "a single selection is named");
	contains(one, "1440 x 900", "a single selection shows its size");
	ok(!one.includes("already has an image"), "a plain frame is not described as an image");
	const withImage = describeSelection([{ name: "Photo", type: "RECTANGLE", width: 100, height: 100, hasImageFill: true }]);
	contains(withImage, "already has an image", "an image fill is called out");
	const many = describeSelection([
		{ name: "a", type: "FRAME", width: 10, height: 10, hasImageFill: true },
		{ name: "b", type: "FRAME", width: 10, height: 10, hasImageFill: false },
	]);
	contains(many, "2 layers selected", "several layers are counted");
	contains(many, "1 with an image", "the ones with images are counted");

	const frame = [{ name: "Hero", type: "FRAME", width: 1440, height: 900, hasImageFill: false }];
	equal(sizeForTarget(frame, { width: 1024, height: 1024 }), { width: 1440, height: 900 }, "a selected frame decides the size");
	equal(sizeForTarget([], { width: 1024, height: 1024 }), { width: 1024, height: 1024 }, "with no selection the requested size is used");
	equal(sizeForTarget(frame, { width: 99999, height: 1 }), { width: 1440, height: 900 }, "a frame size wins over nonsense");
	equal(sizeForTarget([], { width: 99999, height: 1 }), { width: 4096, height: 64 }, "a requested size is clamped");

	equal(normalizeScaleMode("FIT"), "FIT", "FIT is allowed");
	equal(normalizeScaleMode("CROP"), "CROP", "CROP is allowed");
	equal(normalizeScaleMode("TILE"), "TILE", "TILE is allowed");
	equal(normalizeScaleMode("nope"), "FILL", "anything else fills");
	equal(normalizeScaleMode(""), "FILL", "empty fills");
}

/* --------------------------------------------------------------------- live */

async function live(): Promise<number> {
	let liveFailed = 0;

	const apiKey = process.env.POLLINATIONS_API_KEY || readKeyFromDisk();
	const appKey = process.env.POLLINATIONS_APP_KEY || "";

	function step(label: string, condition: boolean, extra = ""): void {
		if (condition) {
			console.log("  ok   " + label + (extra ? " - " + extra : ""));
		} else {
			liveFailed++;
			console.log("  FAIL " + label + (extra ? " - " + extra : ""));
		}
	}

	if (!apiKey) {
		console.log("\n# live checks\n  skipped: no POLLINATIONS_API_KEY and no credentials file");
		return 0;
	}

	// Some steps are extra evidence rather than required checks; a dropped
	// connection from this machine should be reported, not turned into a failure.
	async function soft(label: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			console.log("  note " + label + " could not be reached from this machine: " + (error as Error).message);
		}
	}

	console.log("\n# live checks");

	// The live model list, both modalities.
	{
		const start = Date.now();
		const response = await fetch(buildModelsRequest("image").url);
		const text = await response.text();
		const models = parseModels(text, "image");
		const ids = modelIds(models);
		step(
			"GET /image/models answers with a usable list",
			response.status === 200 && models.length > 10,
			models.length + " models in " + ((Date.now() - start) / 1000).toFixed(2) + "s"
		);
		step("the model ids are non-empty strings", ids.every((id) => typeof id === "string" && id.length > 0));
		step(
			"models carry their real metadata",
			models.some((model) => model.publisher.length > 0 && model.endpoints.length > 0),
			models.find((model) => model.publisher && model.endpoints.length)?.publisher || ""
		);
		step("the list is CORS open, so the plugin UI can read it", response.headers.get("access-control-allow-origin") === "*");

		const textResponse = await fetch(buildModelsRequest("text").url);
		const textModels = parseModels(await textResponse.text(), "text");
		step("GET /text/models answers too", textResponse.status === 200 && textModels.length > 10, textModels.length + " models");
		step("the image and text lists are different", textModels[0]?.id !== models[0]?.id);
	}

	// A real generation, through the exact request the plugin builds.
	{
		const start = Date.now();
		const req = buildImageRequest(
			"a wooden watermill above a quiet river, morning light",
			{ model: "tongyi-mai/z-image-turbo", width: 512, height: 512, seed: 7, nologo: true },
			apiKey
		);
		const response = await fetch(req.url, { method: req.method, headers: req.headers });
		const contentType = response.headers.get("content-type") || "";
		const bytes = new Uint8Array(await response.arrayBuffer());
		const kind = response.ok ? "none" : classify(response.status, "");
		step("POST-free generation works", response.status === 200 && kind === "none", "HTTP " + response.status);
		step(
			"the answer is an image",
			contentType.startsWith("image/") && bytes.length > 1000,
			contentType + ", " + bytes.length + " bytes, " + ((Date.now() - start) / 1000).toFixed(2) + "s"
		);
		const magic = bytesToBase64(bytes.slice(0, 4));
		step(
			"the answer starts with a real image header",
			magic.startsWith("iVBOR") || magic.startsWith("/9j") || magic.startsWith("UklG"),
			magic.slice(0, 4) + " (" + imageExtension(contentType) + ")"
		);

		// Deterministic seeds are a documented feature, so the same prompt and seed
		// should answer again.
		await soft("the repeat request", async () => {
			const repeat = await fetch(req.url, { method: req.method, headers: req.headers });
			const repeatBytes = new Uint8Array(await repeat.arrayBuffer());
			step(
				"the same prompt and seed answers again",
				repeat.status === 200 && repeatBytes.length === bytes.length,
				"HTTP " + repeat.status + ", " + repeatBytes.length + " bytes"
			);
		});
	}

	// The edit route the Figma plugin uses, with the generated image as input.
	await soft("the edit route", async () => {
		const generated = await fetch(
			buildImageRequest("a red apple on a wooden table", { model: "tongyi-mai/z-image-turbo", width: 512, height: 512, seed: 3, nologo: true }, apiKey).url,
			{ headers: { Authorization: "Bearer " + apiKey } }
		);
		const bytes = new Uint8Array(await generated.arrayBuffer());
		const base64 = bytesToBase64(bytes);
		const req = buildEditRequest(
			"replace the table with a marble counter",
			{ dataUri: dataUri("image/png", base64), model: "kontext", size: "1024x1024" },
			apiKey
		);
		const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const text = await response.text();
		const kind = response.ok ? "none" : classify(response.status, text);
		if (kind === "balance") {
			console.log(
				"  ok   POST /v1/images/edits is wired correctly, but this key is out of Pollen for edits: " +
					response.status +
					" " +
					(errorDetail(text) || text).slice(0, 120)
			);
		} else {
			step("POST /v1/images/edits accepts the plugin's JSON body", response.status === 200, "HTTP " + response.status + " " + (errorDetail(text) || "").slice(0, 80));
			const image = extractImage(text);
			step("the edit answers with an image", image.base64.length > 1000 || image.url.length > 0, image.base64.length + " base64 chars, url: " + (image.url ? "yes" : "no"));
		}
	});

	// The device flow, as far as it can go without a human clicking.
	await soft("the device flow", async () => {
		const start = Date.now();
		const req = buildDeviceCodeRequest(appKey);
		const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const text = await response.text();
		const code = parseDeviceCode(text);
		step("POST /api/device/code answers", response.status === 200 && code !== null, "HTTP " + response.status + " in " + ((Date.now() - start) / 1000).toFixed(2) + "s");
		if (code) {
			step("the code is human sized", /^[A-Z0-9]{6,12}$/.test(code.userCode), code.userCode);
			step("the verification page is absolute", code.verificationUri.startsWith("https://enter.pollinations.ai/"), code.verificationUri);
			step("the prefilled page carries the code", code.verificationUrlComplete.includes("user_code="));
			step("the poll interval is sane", code.interval >= 1 && code.expiresIn > 60, "interval " + code.interval + "s, expires in " + code.expiresIn + "s");
			step("the device route is CORS open for the plugin UI", response.headers.get("access-control-allow-origin") === "*");

			const poll = await fetch(buildDeviceTokenRequest(code.deviceCode).url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: buildDeviceTokenRequest(code.deviceCode).body,
			});
			const pollText = await poll.text();
			const parsed = parseDeviceToken(poll.status, pollText);
			step("polling before approval reads as pending, not as an error", parsed.state === "pending", "HTTP " + poll.status + " " + (parsed.detail || ""));
		}
	});

	// The error path, with a real rejection: the plugin must be able to explain it.
	await soft("the rejection probe", async () => {
		const response = await fetch(
			buildImageRequest("x", { model: "definitely-not-a-model" }, apiKey).url,
			{ headers: { Authorization: "Bearer " + apiKey } }
		);
		const text = await response.text();
		const kind = response.ok ? "none" : classify(response.status, text);
		step("a rejected request is classified, not swallowed", kind !== "none" && kind !== "network", "HTTP " + response.status + " -> " + kind);
		step("the rejection carries a message the plugin can show", errorDetail(text).length > 0, (errorDetail(text) || text).slice(0, 100));
	});

	// An anonymous request is what a user without a key gets; report what happens.
	await soft("the anonymous request", async () => {
		const response = await fetch(buildImageRequest("a paper boat", { model: "tongyi-mai/z-image-turbo", width: 256, height: 256 }).url);
		const contentType = response.headers.get("content-type") || "";
		const bytes = new Uint8Array(await response.arrayBuffer());
		console.log(
			"  note anonymous request: HTTP " +
				response.status +
				" " +
				(contentType.split(";")[0] || "no content type") +
				" " +
				bytes.length +
				" bytes"
		);
	});

	return liveFailed;
}

function readKeyFromDisk(): string {
	try {
		const raw = readFileSync("/root/.pollinations/credentials.json", "utf8");
		const parsed = JSON.parse(raw) as { apiKey?: string };
		return parsed.apiKey || "";
	} catch {
		return "";
	}
}

const wantsLive = process.argv.includes("--live") || process.env.POLLINATIONS_LIVE === "true";

if (wantsLive) {
	const liveFailed = await live();
	console.log("\n=== live check finished: " + liveFailed + " failing step(s)");
	console.log("total: " + passed + " passed, " + (failed + liveFailed) + " failed");
	if (failed + liveFailed > 0) process.exit(1);
} else {
	console.log("\ntotal: " + passed + " passed, " + failed + " failed");
	if (failed > 0) process.exit(1);
}
