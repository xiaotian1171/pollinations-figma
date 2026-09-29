/**
 * The UI iframe. It owns the network: the API key never has to travel into the
 * sandbox, and the iframe is a normal browser context with fetch and FormData.
 */

import {
	backoffSeconds,
	buildDeviceCodeRequest,
	buildDeviceTokenRequest,
	buildEditRequest,
	buildImageRequest,
	buildModelsRequest,
	buildUserInfoRequest,
	bytesToBase64,
	classify,
	dataUri,
	errorDetail,
	extractImage,
	isTextual,
	type ErrorKind,
	messageFor,
	parseDeviceCode,
	parseDeviceToken,
	parseModels,
	parseUserInfo,
	type ApiRequest,
	type ModelInfo,
} from "./shared/api";
import { SIZE_PRESETS, clampSeed, clampSize, describeSelection, normalizeScaleMode } from "./shared/format";
import type { CodeToUi, NodeSummary, StoredSettings, UiToCode } from "./shared/messages";

const DEFAULT_MODEL = "tongyi-mai/z-image-turbo";
const DEVICE_FLOW_APP_KEY = "pk_yFMsWNGA5WfEAsSw";

let settings: StoredSettings = {
	apiKey: "",
	appKey: "",
	model: "",
	width: 1024,
	height: 1024,
	seed: -1,
	scaleMode: "FILL",
	nologo: false,
	safe: false,
	prompt: "",
};
let selection: NodeSummary[] = [];
let imageModels: ModelInfo[] = [];
let selectionImage: { base64: string; mime: string; name: string } | null = null;
let busy = false;
let signingIn = false;
let pollTimer: number | null = null;

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error("missing element " + id);
	return element as T;
}

function send(message: UiToCode): void {
	parent.postMessage({ pluginMessage: message }, "*");
}

function status(text: string, kind: "info" | "error" | "busy" = "info"): void {
	const element = byId("status");
	element.textContent = text;
	element.className = "status " + kind;
}

function setBusy(value: boolean, label?: string): void {
	busy = value;
	for (const id of ["generate", "fill", "edit"]) {
		const button = byId<HTMLButtonElement>(id);
		button.disabled = value || (id === "edit" && !selectionImage);
	}
	byId("spinner").className = value ? "spinner on" : "spinner";
	if (label) status(label, "busy");
	updateActionLabels();
}

function updateActionLabels(): void {
	byId<HTMLButtonElement>("generate").textContent =
		selection.length > 0 ? "Generate and fill selection" : "Generate new layer";
	byId<HTMLButtonElement>("fill").textContent =
		selection.length > 1 ? "Fill " + selection.length + " layers" : "Fill selection";
	byId<HTMLButtonElement>("edit").textContent = "Edit selected image";
	byId("selection").textContent = describeSelection(selection);
	byId<HTMLButtonElement>("fill").disabled = busy || selection.length === 0;
	byId<HTMLButtonElement>("edit").disabled = busy || !selectionImage;
}

/* ------------------------------------------------------------------- network */

interface Answer {
	status: number;
	contentType: string;
	text: string;
	bytes: Uint8Array;
	kind: ErrorKind;
}

async function request(req: ApiRequest, attempts = 3): Promise<Answer> {
	let attempt = 0;
	let lastKind: ErrorKind = "network";
	while (attempt < attempts) {
		attempt++;
		let response: Response | null = null;
		try {
			response = await fetch(req.url, {
				method: req.method,
				headers: req.headers,
				body: req.body,
			});
		} catch {
			lastKind = "network";
			if (attempt < attempts) {
				await sleep(backoffSeconds(attempt) * 1000);
				continue;
			}
			return { status: 0, contentType: "", text: "", bytes: new Uint8Array(0), kind: lastKind };
		}

		const contentType = response.headers.get("content-type") || "";
		if (isTextual(contentType)) {
			const text = await response.text();
			const kind = classify(response.status, text);
			if (kind !== "none" && (kind === "rate_limit" || kind === "server") && attempt < attempts) {
				await sleep(backoffSeconds(attempt) * 1000);
				lastKind = kind;
				continue;
			}
			return { status: response.status, contentType, text, bytes: new Uint8Array(0), kind };
		}

		const buffer = await response.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		const kind = response.ok ? (bytes.length ? "none" : "parse") : classify(response.status, "");
		if ((kind === "rate_limit" || kind === "server") && attempt < attempts) {
			await sleep(backoffSeconds(attempt) * 1000);
			lastKind = kind;
			continue;
		}
		return { status: response.status, contentType, text: "", bytes, kind };
	}
	return { status: 0, contentType: "", text: "", bytes: new Uint8Array(0), kind: lastKind };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function openLink(url: string): void {
	const opened = window.open(url, "_blank");
	if (!opened) {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.target = "_blank";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}
}

/* ------------------------------------------------------------------- actions */

async function loadModels(): Promise<void> {
	const answer = await request(buildModelsRequest("image"), 2);
	if (answer.kind !== "none") {
		byId("model-note").textContent = "Could not load the live model list (" + messageFor(answer.kind, answer.status) + ")";
		return;
	}
	imageModels = parseModels(answer.text, "image");
	imageModels.sort((a, b) => a.id.localeCompare(b.id));

	const select = byId<HTMLSelectElement>("model");
	select.innerHTML = "";
	for (const model of imageModels) {
		const option = document.createElement("option");
		option.value = model.id;
		option.textContent = model.title === model.id ? model.id : model.title + " (" + model.id + ")";
		if (model.description) option.title = model.description;
		select.appendChild(option);
	}

	const remembered = settings.model && imageModels.some((model) => model.id === settings.model) ? settings.model : "";
	const chosen = remembered || (imageModels.some((model) => model.id === DEFAULT_MODEL) ? DEFAULT_MODEL : "") ||
		(imageModels[0] ? imageModels[0].id : "");
	if (chosen) {
		select.value = chosen;
		settings.model = chosen;
		save();
	}
	byId("model-note").textContent = imageModels.length + " image models straight from the live list.";
}

function save(): void {
	send({ type: "save-settings", settings });
}

async function generate(target: "new" | "selection"): Promise<void> {
	const prompt = byId<HTMLTextAreaElement>("prompt").value.trim();
	if (!prompt) {
		status("Write a prompt first.", "error");
		return;
	}
	if (!settings.apiKey) {
		status("Sign in first, or paste an API key in the settings.", "error");
		return;
	}

	setBusy(true, "Asking Pollinations...");
	settings.prompt = prompt;
	save();

	const req = buildImageRequest(
		prompt,
		{
			model: byId<HTMLSelectElement>("model").value || settings.model,
			width: clampSize(Number(byId<HTMLInputElement>("width").value)),
			height: clampSize(Number(byId<HTMLInputElement>("height").value)),
			seed: clampSeed(Number(byId<HTMLInputElement>("seed").value)),
			nologo: byId<HTMLInputElement>("nologo").checked,
			safe: byId<HTMLInputElement>("safe").checked,
		},
		settings.apiKey
	);
	const answer = await request(req);
	if (answer.kind !== "none") {
		setBusy(false);
		status(messageFor(answer.kind, answer.status, errorDetail(answer.text)), "error");
		return;
	}

	setBusy(false, "Placing it on the canvas...");
	send({
		type: "place-image",
		base64: bytesToBase64(answer.bytes),
		mime: answer.contentType.split(";")[0] || "image/png",
		prompt,
		target,
		width: clampSize(Number(byId<HTMLInputElement>("width").value)),
		height: clampSize(Number(byId<HTMLInputElement>("height").value)),
		scaleMode: normalizeScaleMode(byId<HTMLSelectElement>("scale").value),
	});
}

async function editSelection(): Promise<void> {
	if (!selectionImage) {
		status("Select a layer that already has an image fill.", "error");
		return;
	}
	const prompt = byId<HTMLTextAreaElement>("prompt").value.trim();
	if (!prompt) {
		status("Write what should change in the prompt.", "error");
		return;
	}
	if (!settings.apiKey) {
		status("Sign in first, or paste an API key in the settings.", "error");
		return;
	}

	setBusy(true, "Editing " + selectionImage.name + "...");
	const size = byId<HTMLSelectElement>("edit-size").value;
	const req = buildEditRequest(
		prompt,
		{
			dataUri: dataUri(selectionImage.mime, selectionImage.base64),
			model: byId<HTMLSelectElement>("edit-model").value || "",
			size: size || undefined,
		},
		settings.apiKey
	);
	const answer = await request(req);
	if (answer.kind !== "none") {
		setBusy(false);
		status(messageFor(answer.kind, answer.status, errorDetail(answer.text)), "error");
		return;
	}

	const image = extractImage(answer.text);
	if (!image.base64 && !image.url) {
		setBusy(false);
		status("The edit came back without an image.", "error");
		return;
	}

	let base64 = image.base64;
	let mime = "image/png";
	if (!base64 && image.url) {
		const fetched = await request({ url: image.url, method: "GET", headers: {} });
		if (fetched.kind !== "none" || fetched.bytes.length === 0) {
			setBusy(false);
			status("The edit came back as a link the plugin could not download.", "error");
			return;
		}
		base64 = bytesToBase64(fetched.bytes);
		mime = fetched.contentType.split(";")[0] || mime;
	}

	setBusy(false, "Placing the edited image...");
	send({
		type: "place-image",
		base64,
		mime,
		prompt,
		target: "new",
		width: clampSize(Number(byId<HTMLInputElement>("width").value)),
		height: clampSize(Number(byId<HTMLInputElement>("height").value)),
		scaleMode: normalizeScaleMode(byId<HTMLSelectElement>("scale").value),
	});
}

/* ---------------------------------------------------------------- signing in */

const IMAGE_EDIT_MODELS = [
	{ id: "", label: "Server default" },
	{ id: "kontext", label: "kontext" },
	{ id: "black-forest-labs/flux.2-klein-4b", label: "flux.2-klein-4b" },
	{ id: "google/gemini-2.5-flash-image", label: "gemini-2.5-flash-image" },
	{ id: "bytedance/seedream-4.0", label: "seedream-4.0" },
];

async function signIn(): Promise<void> {
	if (signingIn) {
		signingIn = false;
		if (pollTimer !== null) window.clearTimeout(pollTimer);
		pollTimer = null;
		byId("signin").textContent = "Sign in with a code";
		status("Sign-in cancelled.", "info");
		return;
	}

	signingIn = true;
	byId("signin").textContent = "Cancel sign-in";
	status("Asking for a code...", "busy");

	const answer = await request(buildDeviceCodeRequest(settings.appKey || DEVICE_FLOW_APP_KEY), 1);
	if (answer.kind !== "none") {
		signingIn = false;
		byId("signin").textContent = "Sign in with a code";
		status(messageFor(answer.kind, answer.status, errorDetail(answer.text)), "error");
		return;
	}

	const code = parseDeviceCode(answer.text);
	if (!code) {
		signingIn = false;
		byId("signin").textContent = "Sign in with a code";
		status("Pollinations did not return a device code.", "error");
		return;
	}

	const box = byId("device");
	box.style.display = "block";
	byId("device-code").textContent = code.userCode;
	status("Enter the code in your browser, then come back here.", "info");

	const link = byId<HTMLAnchorElement>("device-link");
	link.textContent = code.verificationUri;
	link.onclick = (event) => {
		event.preventDefault();
		openLink(code.verificationUrlComplete);
	};

	const deadline = Date.now() + code.expiresIn * 1000;
	let interval = code.interval;

	const poll = async (): Promise<void> => {
		if (!signingIn) return;
		if (Date.now() > deadline) {
			signingIn = false;
			byId("signin").textContent = "Sign in with a code";
			status("The code expired. Ask for a new one.", "error");
			return;
		}

		const result = await request(buildDeviceTokenRequest(code.deviceCode), 1);
		const parsed = parseDeviceToken(result.status, result.text);
		if (parsed.interval > 0) interval = parsed.interval;

		if (parsed.state === "granted") {
			signingIn = false;
			settings.apiKey = parsed.apiKey;
			save();
			applyKeyState();
			byId("signin").textContent = "Sign in with a code";
			await showAccount();
			return;
		}
		if (parsed.state === "denied" || parsed.state === "expired" || parsed.state === "error") {
			signingIn = false;
			byId("signin").textContent = "Sign in with a code";
			status(
				parsed.state === "denied"
					? "The sign-in was denied."
					: parsed.state === "expired"
						? "The code expired. Ask for a new one."
						: "Sign-in failed: " + (parsed.detail || "unknown error"),
				"error"
			);
			return;
		}
		if (parsed.state === "slow_down") interval += 5;
		pollTimer = window.setTimeout(() => void poll(), Math.max(1, interval) * 1000);
	};

	pollTimer = window.setTimeout(() => void poll(), Math.max(1, interval) * 1000);
}

function applyKeyState(): void {
	const state = byId("key-state");
	if (settings.apiKey) {
		state.textContent = "Signed in, key stored in this Figma client.";
		byId("account").textContent = "";
	} else {
		state.textContent = "No API key yet.";
		byId("account").textContent = "";
	}
	byId<HTMLInputElement>("api-key").value = settings.apiKey;
}

async function showAccount(): Promise<void> {
	const answer = await request(buildUserInfoRequest(settings.apiKey), 1);
	if (answer.kind !== "none") {
		byId("account").textContent = "Signed in.";
		return;
	}
	const user = parseUserInfo(answer.text);
	byId("account").textContent = user.name ? "Signed in as " + user.name + "." : "Signed in.";
}

function signOut(): void {
	settings.apiKey = "";
	save();
	applyKeyState();
	status("Signed out.", "info");
}

/* ------------------------------------------------------------------ wiring */

function buildStaticLists(): void {
	const preset = byId<HTMLSelectElement>("preset");
	preset.innerHTML = "";
	const custom = document.createElement("option");
	custom.value = "custom";
	custom.textContent = "Custom";
	preset.appendChild(custom);
	for (let index = 0; index < SIZE_PRESETS.length; index++) {
		const item = SIZE_PRESETS[index];
		const option = document.createElement("option");
		option.value = String(index);
		option.textContent = item.name;
		preset.appendChild(option);
	}

	const editModel = byId<HTMLSelectElement>("edit-model");
	editModel.innerHTML = "";
	for (const model of IMAGE_EDIT_MODELS) {
		const option = document.createElement("option");
		option.value = model.id;
		option.textContent = model.label;
		editModel.appendChild(option);
	}

	const editSize = byId<HTMLSelectElement>("edit-size");
	editSize.innerHTML = "";
	for (const value of ["", "1024x1024", "1536x1024", "1024x1536"]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value || "Model default";
		editSize.appendChild(option);
	}

	const scale = byId<HTMLSelectElement>("scale");
	scale.innerHTML = "";
	for (const value of ["FILL", "FIT", "CROP", "TILE"]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		scale.appendChild(option);
	}

	const details = byId("details") as HTMLDetailsElement;
	details.open = false;
}

function applySettings(): void {
	byId<HTMLTextAreaElement>("prompt").value = settings.prompt || "";
	byId<HTMLInputElement>("width").value = String(settings.width);
	byId<HTMLInputElement>("height").value = String(settings.height);
	byId<HTMLInputElement>("seed").value = String(settings.seed);
	byId<HTMLInputElement>("nologo").checked = settings.nologo;
	byId<HTMLInputElement>("safe").checked = settings.safe;
	byId<HTMLSelectElement>("scale").value = normalizeScaleMode(settings.scaleMode);
	byId<HTMLInputElement>("app-key").value = settings.appKey;
	applyKeyState();
	updateActionLabels();
}

function wire(): void {
	byId("generate").addEventListener("click", () => {
		void generate(selection.length > 0 ? "selection" : "new");
	});
	byId("fill").addEventListener("click", () => void generate("selection"));
	byId("edit").addEventListener("click", () => void editSelection());
	byId("refresh-models").addEventListener("click", () => void loadModels());
	byId("signin").addEventListener("click", () => void signIn());
	byId("signout").addEventListener("click", () => signOut());
	byId("key-page").addEventListener("click", (event) => {
		event.preventDefault();
		openLink("https://enter.pollinations.ai/keys");
	});
	byId("refresh-selection").addEventListener("click", () => send({ type: "refresh-selection" }));

	byId<HTMLSelectElement>("preset").addEventListener("change", () => {
		const value = byId<HTMLSelectElement>("preset").value;
		if (value === "custom") return;
		const item = SIZE_PRESETS[Number(value)];
		if (!item) return;
		byId<HTMLInputElement>("width").value = String(item.width);
		byId<HTMLInputElement>("height").value = String(item.height);
		settings.width = item.width;
		settings.height = item.height;
		save();
	});

	const onFieldChange = (): void => {
		settings.width = clampSize(Number(byId<HTMLInputElement>("width").value));
		settings.height = clampSize(Number(byId<HTMLInputElement>("height").value));
		settings.seed = clampSeed(Number(byId<HTMLInputElement>("seed").value));
		settings.nologo = byId<HTMLInputElement>("nologo").checked;
		settings.safe = byId<HTMLInputElement>("safe").checked;
		settings.scaleMode = normalizeScaleMode(byId<HTMLSelectElement>("scale").value);
		settings.apiKey = byId<HTMLInputElement>("api-key").value.trim();
		settings.appKey = byId<HTMLInputElement>("app-key").value.trim();
		settings.model = byId<HTMLSelectElement>("model").value || settings.model;
		save();
	};
	for (const id of ["width", "height", "seed", "nologo", "safe", "scale", "api-key", "app-key", "model"]) {
		byId(id).addEventListener("change", onFieldChange);
	}

	byId("copy-code").addEventListener("click", () => {
		const code = byId("device-code").textContent || "";
		if (navigator.clipboard) void navigator.clipboard.writeText(code);
		status("Code copied.", "info");
	});
}

window.onmessage = (event: MessageEvent) => {
	const message = event.data.pluginMessage as CodeToUi | undefined;
	if (!message) return;

	switch (message.type) {
		case "settings":
			settings = Object.assign(settings, message.settings);
			applySettings();
			break;
		case "selection":
			selection = message.nodes;
			selectionImage = null;
			updateActionLabels();
			if (selection.some((node) => node.hasImageFill)) send({ type: "request-selection-image" });
			break;
		case "selection-image":
			selectionImage = { base64: message.base64, mime: message.mime, name: message.name };
			status("Editing will use " + message.name + ".", "info");
			updateActionLabels();
			break;
		case "selection-image-missing":
			selectionImage = null;
			updateActionLabels();
			break;
		case "placed":
			status("Added " + message.name + " to the canvas.", "info");
			break;
		case "error":
			status(message.message, "error");
			break;
		default:
			break;
	}
};

async function start(): Promise<void> {
	buildStaticLists();
	wire();
	applySettings();
	send({ type: "ui-ready" });
	void loadModels();
}

void start();

export {};
