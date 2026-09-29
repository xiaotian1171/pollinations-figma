/**
 * Everything about the Pollinations HTTP API that does not need Figma: URLs,
 * request shapes, response parsing, error kinds. Both the plugin sandbox and the
 * UI import this, and the test suite runs it in Node.
 */

export const GEN_BASE = "https://gen.pollinations.ai";
export const ENTER_BASE = "https://enter.pollinations.ai";

export type Modality = "text" | "image";

export type ErrorKind =
	| "none"
	| "auth"
	| "balance"
	| "rate_limit"
	| "bad_request"
	| "server"
	| "network"
	| "parse";

export interface ApiRequest {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
}

export interface ImageOptions {
	model?: string;
	width?: number;
	height?: number;
	seed?: number;
	nologo?: boolean;
	safe?: boolean;
	enhance?: boolean;
	transparent?: boolean;
}

export interface ModelInfo {
	id: string;
	title: string;
	category: string;
	publisher: string;
	description: string;
	aliases: string[];
	endpoints: string[];
}

/* ------------------------------------------------------------------ requests */

export function authHeaders(apiKey: string): Record<string, string> {
	return apiKey ? { Authorization: "Bearer " + apiKey } : {};
}

export function jsonHeaders(apiKey: string): Record<string, string> {
	return Object.assign({ "Content-Type": "application/json" }, authHeaders(apiKey));
}

function query(pairs: Array<[string, string | number | boolean | undefined]>): string {
	const parts: string[] = [];
	for (const [key, value] of pairs) {
		if (value === undefined || value === null || value === "") continue;
		if (typeof value === "number" && !isFinite(value)) continue;
		parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
	}
	return parts.length ? "?" + parts.join("&") : "";
}

export function buildImageRequest(prompt: string, options: ImageOptions = {}, apiKey = ""): ApiRequest {
	return {
		url:
			GEN_BASE +
			"/image/" +
			encodeURIComponent(prompt) +
			query([
				["model", options.model],
				["width", options.width],
				["height", options.height],
				["seed", options.seed],
				["nologo", options.nologo],
				["safe", options.safe],
				["enhance", options.enhance],
				["transparent", options.transparent],
			]),
		method: "GET",
		headers: authHeaders(apiKey),
	};
}

/** OpenAI-compatible edit: the source image travels as a data URI. */
export function buildEditRequest(
	prompt: string,
	source: { dataUri: string; model?: string; size?: string },
	apiKey = ""
): ApiRequest {
	const payload: Record<string, unknown> = {
		prompt,
		image: source.dataUri,
		response_format: "b64_json",
	};
	if (source.model) payload.model = source.model;
	if (source.size) payload.size = source.size;

	return {
		url: GEN_BASE + "/v1/images/edits",
		method: "POST",
		headers: jsonHeaders(apiKey),
		body: JSON.stringify(payload),
	};
}

export function buildModelsRequest(modality: Modality): ApiRequest {
	return { url: GEN_BASE + "/" + modality + "/models", method: "GET", headers: {} };
}

export function buildDeviceCodeRequest(appKey: string): ApiRequest {
	return {
		url: ENTER_BASE + "/api/device/code",
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(appKey ? { client_id: appKey } : {}),
	};
}

export function buildDeviceTokenRequest(deviceCode: string): ApiRequest {
	return {
		url: ENTER_BASE + "/api/device/token",
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device_code: deviceCode }),
	};
}

export function buildUserInfoRequest(apiKey: string): ApiRequest {
	return { url: ENTER_BASE + "/api/device/userinfo", method: "GET", headers: authHeaders(apiKey) };
}

export function verificationUrl(uri: string, userCode: string, withCode: boolean): string {
	const target = uri && uri.startsWith("http") ? uri : ENTER_BASE + (uri || "/device");
	return withCode ? target + "?user_code=" + encodeURIComponent(userCode) : target;
}

/* ------------------------------------------------------------ classification */

const BALANCE_PATTERNS = [
	/[iI]nsufficient balance/,
	/insufficient_balance/,
	/[oO]ut of pollen/,
	/[nN]o pollen/,
	/balance is too low/,
];

export function mentionsBalance(body: string): boolean {
	if (!body) return false;
	return BALANCE_PATTERNS.some((pattern) => pattern.test(body));
}

export function classify(status: number, body: string, transportFailed = false, parseFailed = false): ErrorKind {
	if (transportFailed) return "network";
	if (status === 0) return "network";
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "balance";
	if (status === 429) return "rate_limit";
	if (status === 400 || status === 404 || status === 422) return "bad_request";
	if (status >= 500) return "server";
	if (status >= 200 && status < 300) {
		if (parseFailed) return "parse";
		if (mentionsBalance(body)) return "balance";
		return "none";
	}
	return "unknown" as ErrorKind;
}

export function retryable(kind: ErrorKind): boolean {
	return kind === "rate_limit" || kind === "server" || kind === "network";
}

export function backoffSeconds(attempt: number, base = 0.75, cap = 8): number {
	if (attempt <= 1) return base;
	return Math.min(cap, base * Math.pow(2, attempt - 1));
}

export function kindName(kind: ErrorKind): string {
	return kind === "none" ? "success" : kind.replace("_", " ");
}

export function messageFor(kind: ErrorKind, status = 0, detail = ""): string {
	switch (kind) {
		case "none":
			return "Done.";
		case "auth":
			return "Pollinations rejected the API key. Sign in again or check the key in the plugin.";
		case "balance":
			return "This key is out of Pollen. Top up your account, or sign in with one that has some.";
		case "rate_limit":
			return "Pollinations is rate limiting this key. Wait a moment and try again.";
		case "bad_request":
			return "Pollinations rejected the request: " + (detail || "HTTP " + status) + ".";
		case "server":
			return "Pollinations had a server error (HTTP " + status + "). It was retried a few times.";
		case "network":
			return "Could not reach Pollinations. Check the connection and try again.";
		case "parse":
			return "Pollinations answered with something the plugin could not read.";
		default:
			return "Unexpected answer from Pollinations (HTTP " + status + ").";
	}
}

/* ------------------------------------------------------------------- reading */

function asObject(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The base64 payload or the URL of the first image in an images response. */
export function extractImage(body: string): { base64: string; url: string } {
	const root = asObject(parseJson(body));
	if (!root) return { base64: "", url: "" };
	const first = asObject(asArray(root.data)[0]);
	if (!first) return { base64: "", url: "" };
	return {
		base64: typeof first.b64_json === "string" ? first.b64_json : "",
		url: typeof first.url === "string" ? first.url : "",
	};
}

export function errorDetail(body: string): string {
	const root = asObject(parseJson(body));
	if (!root) return "";
	const error = root.error;
	if (typeof error === "string") return error;
	const errorObject = asObject(error);
	if (errorObject && typeof errorObject.message === "string") return errorObject.message;
	if (typeof root.message === "string") return root.message;
	return "";
}

/* -------------------------------------------------------------------- models */

function modelFromEntry(entry: unknown, fallbackCategory: string): ModelInfo | null {
	const object = asObject(entry);
	if (!object) return null;
	const id = (typeof object.name === "string" && object.name) || (typeof object.id === "string" && object.id) || "";
	if (!id) return null;

	return {
		id,
		title: (typeof object.title === "string" && object.title) || id,
		category: (typeof object.category === "string" && object.category) || fallbackCategory,
		publisher: (typeof object.publisher === "string" && object.publisher) || "",
		description: (typeof object.description === "string" && object.description) || "",
		aliases: asArray(object.aliases).filter((alias): alias is string => typeof alias === "string"),
		endpoints: asArray(object.supported_endpoints).filter(
			(endpoint): endpoint is string => typeof endpoint === "string"
		),
	};
}

export function parseModels(body: string, modality: Modality = "image"): ModelInfo[] {
	const parsed = parseJson(body);
	let entries: unknown[] = [];
	if (Array.isArray(parsed)) {
		entries = parsed;
	} else {
		const root = asObject(parsed);
		if (root) {
			if (Array.isArray(root.data)) entries = root.data;
			else if (Array.isArray(root.models)) entries = root.models;
			else if (Array.isArray(root.categories)) {
				for (const category of root.categories) {
					const object = asObject(category);
					if (object && Array.isArray(object.models)) entries = entries.concat(object.models);
				}
			}
		}
	}

	const models: ModelInfo[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const model = modelFromEntry(entry, modality);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export function modelIds(models: ModelInfo[]): string[] {
	return models.map((model) => model.id);
}

export function modelsSupporting(models: ModelInfo[], endpoint: string): ModelInfo[] {
	return models.filter((model) => model.endpoints.length === 0 || model.endpoints.includes(endpoint));
}

export function hasModel(models: ModelInfo[], id: string): boolean {
	if (!id) return false;
	return models.some((model) => model.id === id || model.aliases.includes(id));
}

export function findModel(models: ModelInfo[], id: string): ModelInfo | null {
	if (!id) return null;
	return models.find((model) => model.id === id) || models.find((model) => model.aliases.includes(id)) || null;
}

/* --------------------------------------------------------------- device flow */

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUrlComplete: string;
	interval: number;
	expiresIn: number;
}

export function parseDeviceCode(body: string): DeviceCode | null {
	const root = asObject(parseJson(body));
	if (!root) return null;
	const deviceCode = typeof root.device_code === "string" ? root.device_code : "";
	const userCode = typeof root.user_code === "string" ? root.user_code : "";
	if (!deviceCode || !userCode) return null;

	const uri =
		(typeof root.verification_uri === "string" && root.verification_uri) ||
		(typeof root.verification_url === "string" && root.verification_url) ||
		"/device";
	const complete = typeof root.verification_uri_complete === "string" ? root.verification_uri_complete : "";
	const interval = Number(root.interval ?? 5);
	const expiresIn = Number(root.expires_in ?? 900);

	return {
		deviceCode,
		userCode,
		verificationUri: uri.startsWith("http") ? uri : ENTER_BASE + uri,
		verificationUrlComplete: complete
			? complete.startsWith("http")
				? complete
				: ENTER_BASE + complete
			: verificationUrl(uri, userCode, true),
		interval: isFinite(interval) && interval >= 1 ? interval : 1,
		expiresIn: isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
	};
}

export type TokenState = "pending" | "slow_down" | "granted" | "expired" | "denied" | "error";

export interface TokenPoll {
	state: TokenState;
	apiKey: string;
	interval: number;
	detail: string;
}

export function parseDeviceToken(status: number, body: string): TokenPoll {
	const root = asObject(parseJson(body)) || {};
	const error = String(root.error ?? "").toLowerCase();
	const detail =
		(typeof root.error_description === "string" && root.error_description) ||
		(typeof root.message === "string" && root.message) ||
		String(root.error ?? "");
	const interval = Number(root.interval ?? 0);

	if (status >= 200 && status < 300 && typeof root.access_token === "string" && root.access_token) {
		return { state: "granted", apiKey: root.access_token, interval: interval > 0 ? interval : 0, detail };
	}
	if (error === "authorization_pending" || error === "pending" || status === 428) {
		return { state: "pending", apiKey: "", interval: interval > 0 ? interval : 0, detail };
	}
	if (error === "slow_down") return { state: "slow_down", apiKey: "", interval: interval > 0 ? interval : 5, detail };
	if (error === "expired_token" || error === "expired") return { state: "expired", apiKey: "", interval: 0, detail };
	if (error === "access_denied" || error === "denied") return { state: "denied", apiKey: "", interval: 0, detail };
	return { state: "error", apiKey: "", interval: 0, detail };
}

export function parseUserInfo(body: string): { name: string; email: string } {
	const root = asObject(parseJson(body));
	if (!root) return { name: "", email: "" };
	return {
		name:
			(typeof root.name === "string" && root.name) ||
			(typeof root.username === "string" && root.username) ||
			(typeof root.preferred_username === "string" && root.preferred_username) ||
			"",
		email: typeof root.email === "string" ? root.email : "",
	};
}

/* -------------------------------------------------------------------- bodies */

export function isTextual(contentType: string): boolean {
	if (!contentType) return true;
	const mime = contentType.toLowerCase();
	if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) return false;
	if (mime.startsWith("application/octet-stream")) return false;
	return true;
}

export function imageExtension(contentType: string, url = ""): string {
	const mime = (contentType || "").toLowerCase();
	if (mime.includes("png")) return "png";
	if (mime.includes("webp")) return "webp";
	if (mime.includes("gif")) return "gif";
	if (mime.includes("avif")) return "avif";
	if (mime.includes("svg")) return "svg";
	if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
	const fromUrl = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.exec(url || "");
	if (fromUrl) return fromUrl[1].toLowerCase().replace("jpeg", "jpg");
	return "png";
}

export function mimeForExtension(extension: string): string {
	switch ((extension || "").toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "avif":
			return "image/avif";
		default:
			return "image/png";
	}
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without touching btoa or Buffer, so it works in every sandbox. */
export function bytesToBase64(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const a = bytes[index];
		const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
		const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
		const triple = (a << 16) | (b << 8) | c;

		output += BASE64_ALPHABET[(triple >> 18) & 63];
		output += BASE64_ALPHABET[(triple >> 12) & 63];
		output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
		output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
	}
	return output;
}

export function dataUri(mime: string, base64: string): string {
	return "data:" + (mime || "image/png") + ";base64," + base64;
}
