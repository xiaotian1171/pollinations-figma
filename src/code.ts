/**
 * The plugin sandbox: it owns the document. All HTTP happens in the UI iframe
 * (see ui.ts), because that is a full browser context; this file only reads the
 * selection and writes layers.
 */

import { bytesToBase64, mimeForExtension } from "./shared/api";
import { layerName, placementFor, type NodeSummary, type Point, type ScaleMode } from "./shared/format";
import { STORAGE_KEY, type CodeToUi, type StoredSettings, type UiToCode } from "./shared/messages";

figma.showUI(__html__, { width: 400, height: 660, themeColors: true });

const PAGE = figma.currentPage;

function post(message: CodeToUi): void {
	figma.ui.postMessage(message);
}

/* ----------------------------------------------------------------- selection */

function imageHashOf(node: SceneNode): string {
	if (!("fills" in node)) return "";
	const fills = (node as GeometryMixin).fills;
	if (!fills || fills === figma.mixed || !Array.isArray(fills)) return "";
	for (const paint of fills) {
		if (paint.type === "IMAGE") {
			const hash = (paint as ImagePaint).imageHash;
			if (hash) return hash;
		}
	}
	return "";
}

function summarise(nodes: readonly SceneNode[]): NodeSummary[] {
	return nodes.map((node) => ({
		name: node.name,
		type: node.type,
		width: "width" in node ? node.width : 0,
		height: "height" in node ? node.height : 0,
		hasImageFill: imageHashOf(node) !== "",
	}));
}

function sendSelection(): void {
	post({ type: "selection", nodes: summarise(PAGE.selection) });
}

/* ------------------------------------------------------------------ settings */

const DEFAULT_SETTINGS: StoredSettings = {
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

async function loadSettings(): Promise<void> {
	let stored: Partial<StoredSettings> = {};
	try {
		const value = await figma.clientStorage.getAsync(STORAGE_KEY);
		if (value && typeof value === "object") stored = value as Partial<StoredSettings>;
	} catch {
		stored = {};
	}
	post({ type: "settings", settings: Object.assign({}, DEFAULT_SETTINGS, stored) });
}

async function saveSettings(settings: StoredSettings): Promise<void> {
	try {
		await figma.clientStorage.setAsync(STORAGE_KEY, Object.assign({}, DEFAULT_SETTINGS, settings));
	} catch {
		post({ type: "error", message: "Figma refused to store the plugin settings." });
	}
}

/* ------------------------------------------------------------------- placing */

function placementForNewLayer(selection: readonly SceneNode[], width: number, height: number): Point {
	const only = selection.length === 1 ? selection[0] : null;
	const box = only && only.absoluteBoundingBox ? only.absoluteBoundingBox : null;
	if (box) {
		return { x: Math.round(box.x + box.width + 40), y: Math.round(box.y) };
	}
	return placementFor(figma.viewport.center, width, height);
}

function imagePaint(imageHash: string, scaleMode: ScaleMode): ImagePaint {
	return { type: "IMAGE", scaleMode, imageHash } as ImagePaint;
}

function hasFills(node: SceneNode): boolean {
	return "fills" in node;
}

async function placeImage(message: Extract<UiToCode, { type: "place-image" }>): Promise<void> {
	const bytes = base64ToBytes(message.base64);
	if (bytes.length === 0) {
		post({ type: "error", message: "The generated image came back empty." });
		return;
	}

	const image = figma.createImage(bytes);
	const selection = PAGE.selection.slice();
	const fillTargets =
		message.target === "selection" ? selection.filter((node) => hasFills(node)) : ([] as SceneNode[]);

	if (message.target === "selection" && fillTargets.length === 0) {
		post({ type: "error", message: "Fill needs a layer that supports fills (a frame, shape or text layer)." });
		return;
	}

	if (fillTargets.length > 0) {
		for (const node of fillTargets) {
			(node as GeometryMixin).fills = [imagePaint(image.hash, message.scaleMode)];
		}
		figma.viewport.scrollAndZoomIntoView(fillTargets);
		figma.notify("Filled " + fillTargets.length + " layer" + (fillTargets.length === 1 ? "" : "s"));
		post({ type: "placed", name: fillTargets.map((node) => node.name).join(", "), count: fillTargets.length });
		sendSelection();
		return;
	}

	const width = Math.max(1, Math.round(message.width));
	const height = Math.max(1, Math.round(message.height));
	const point = placementForNewLayer(selection, width, height);
	const rectangle = figma.createRectangle();
	rectangle.name = layerName(message.prompt);
	rectangle.resize(width, height);
	rectangle.x = point.x;
	rectangle.y = point.y;
	rectangle.fills = [imagePaint(image.hash, message.scaleMode)];
	rectangle.setRelaunchData({ edit: "Edit this image with Pollinations" });

	PAGE.selection = [rectangle];
	figma.viewport.scrollAndZoomIntoView([rectangle]);
	figma.notify("Added " + rectangle.name);
	post({ type: "placed", name: rectangle.name, count: 1 });
}

function base64ToBytes(base64: string): Uint8Array {
	if (!base64) return new Uint8Array(0);
	const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
	const length = Math.floor((clean.length * 3) / 4);
	const bytes = new Uint8Array(length);
	let byteIndex = 0;
	let buffer = 0;
	let bits = 0;
	for (let index = 0; index < clean.length; index++) {
		const value = table.indexOf(clean[index]);
		if (value < 0) continue;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[byteIndex++] = (buffer >> bits) & 0xff;
		}
	}
	return bytes.slice(0, byteIndex);
}

async function sendSelectionImage(): Promise<void> {
	const selection = PAGE.selection;
	let node: SceneNode | null = null;
	let hash = "";
	for (const candidate of selection) {
		const candidateHash = imageHashOf(candidate);
		if (candidateHash) {
			node = candidate;
			hash = candidateHash;
			break;
		}
	}
	if (!node || !hash) {
		post({ type: "selection-image-missing" });
		return;
	}

	try {
		const image = figma.getImageByHash(hash);
		if (!image) {
			post({ type: "selection-image-missing" });
			return;
		}
		const bytes = await image.getBytesAsync();
		const extension = imageExtensionFromBytes(bytes);
		post({
			type: "selection-image",
			base64: bytesToBase64(bytes),
			mime: mimeForExtension(extension),
			name: node.name,
		});
	} catch {
		post({ type: "selection-image-missing" });
	}
}

function imageExtensionFromBytes(bytes: Uint8Array): string {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
	if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
	if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
	return "png";
}

/* ------------------------------------------------------------------ plumbing */

figma.ui.onmessage = (message: UiToCode) => {
	switch (message.type) {
		case "ui-ready":
			void loadSettings();
			sendSelection();
			break;
		case "load-settings":
			void loadSettings();
			break;
		case "save-settings":
			void saveSettings(message.settings);
			break;
		case "refresh-selection":
			sendSelection();
			break;
		case "request-selection-image":
			void sendSelectionImage();
			break;
		case "place-image":
			void placeImage(message);
			break;
		case "notify":
			figma.notify(message.text, { error: message.error === true, timeout: message.error ? 6 : 3 });
			break;
		case "resize":
			figma.ui.resize(Math.max(320, Math.round(message.width)), Math.max(400, Math.round(message.height)));
			break;
		default:
			break;
	}
};

figma.on("selectionchange", () => sendSelection());
