/**
 * The Figma facing decisions that can be made without Figma: size presets, the
 * name of the layer, where a new layer goes, how an image should fill a shape.
 */

export interface SizePreset {
	name: string;
	width: number;
	height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
	{ name: "Square 1024", width: 1024, height: 1024 },
	{ name: "Landscape 1536x1024", width: 1536, height: 1024 },
	{ name: "Portrait 1024x1536", width: 1024, height: 1536 },
	{ name: "Wide 1920x1080", width: 1920, height: 1080 },
	{ name: "Story 1080x1920", width: 1080, height: 1920 },
	{ name: "Small 512", width: 512, height: 512 },
];

export const MIN_SIZE = 64;
export const MAX_SIZE = 4096;

export type ScaleMode = "FILL" | "FIT" | "TILE" | "CROP";

export function clampSize(value: number): number {
	const size = Math.round(Number(value));
	if (!isFinite(size)) return 1024;
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

export function clampSeed(value: number): number {
	if (!isFinite(value) || value < 0) return -1;
	return Math.min(2147483647, Math.round(value));
}

export function normalizeScaleMode(value: string): ScaleMode {
	return value === "FIT" || value === "TILE" || value === "CROP" ? value : "FILL";
}

const LAYER_PREFIX = "Pollinations - ";

/** `Pollinations - a wooden watermill`, never longer than maxLength. */
export function layerName(prompt: string, maxLength = 80): string {
	const clean = (prompt || "").replace(/\s+/g, " ").trim();
	if (!clean) return "Pollinations";
	const room = Math.max(4, maxLength - LAYER_PREFIX.length - 1);
	const short = clean.length > room ? clean.slice(0, room).trimEnd() + "\u2026" : clean;
	return LAYER_PREFIX + short;
}

export function applyTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
	);
}

export interface Point {
	x: number;
	y: number;
}

/** A new layer is centred on the viewport so it is always visible. */
export function placementFor(viewportCenter: Point, width: number, height: number): Point {
	return {
		x: Math.round(viewportCenter.x - width / 2),
		y: Math.round(viewportCenter.y - height / 2),
	};
}

export interface NodeSummary {
	name: string;
	type: string;
	width: number;
	height: number;
	hasImageFill: boolean;
}

export function describeSelection(nodes: NodeSummary[]): string {
	if (nodes.length === 0) return "Nothing is selected, so the image will be a new layer.";
	if (nodes.length === 1) {
		const node = nodes[0];
		return (
			node.name +
			" (" +
			node.type +
			", " +
			Math.round(node.width) +
			" x " +
			Math.round(node.height) +
			")" +
			(node.hasImageFill ? " already has an image" : "")
		);
	}
	const withImage = nodes.filter((node) => node.hasImageFill).length;
	return nodes.length + " layers selected" + (withImage > 0 ? ", " + withImage + " with an image" : "");
}

/** The target size for a new layer: the selection's size when there is one. */
export function sizeForTarget(
	selection: NodeSummary[],
	requested: { width: number; height: number }
): { width: number; height: number } {
	const first = selection[0];
	if (selection.length === 1 && first && first.width > 0 && first.height > 0) {
		return { width: clampSize(first.width), height: clampSize(first.height) };
	}
	return { width: clampSize(requested.width), height: clampSize(requested.height) };
}

export function isEditable(node: NodeSummary): boolean {
	return node.hasImageFill;
}

/** What a button should say it will do with the current selection. */
export function actionLabel(selection: NodeSummary[], action: "generate" | "fill" | "edit"): string {
	if (action === "generate") return selection.length > 0 ? "Generate and fill the selection" : "Generate a new layer";
	if (action === "fill") return "Fill the selection";
	return "Edit the selected image";
}
