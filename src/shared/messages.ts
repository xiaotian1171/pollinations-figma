/**
 * The message protocol between the plugin sandbox (code.ts) and the UI iframe
 * (ui.ts). Keeping it in one file means both sides stay in step.
 */

import type { ScaleMode } from "./format";

export interface NodeSummary {
	name: string;
	type: string;
	width: number;
	height: number;
	hasImageFill: boolean;
}

export interface StoredSettings {
	apiKey: string;
	appKey: string;
	model: string;
	width: number;
	height: number;
	seed: number;
	scaleMode: ScaleMode;
	nologo: boolean;
	safe: boolean;
	prompt: string;
}

export type UiToCode =
	| { type: "ui-ready" }
	| { type: "load-settings" }
	| { type: "save-settings"; settings: StoredSettings }
	| { type: "refresh-selection" }
	| { type: "request-selection-image" }
	| {
			type: "place-image";
			base64: string;
			mime: string;
			prompt: string;
			target: "new" | "selection";
			width: number;
			height: number;
			scaleMode: ScaleMode;
	  }
	| { type: "notify"; text: string; error?: boolean }
	| { type: "resize"; width: number; height: number };

export type CodeToUi =
	| { type: "settings"; settings: Partial<StoredSettings> }
	| { type: "selection"; nodes: NodeSummary[] }
	| { type: "selection-image"; base64: string; mime: string; name: string }
	| { type: "selection-image-missing" }
	| { type: "placed"; name: string; count: number }
	| { type: "error"; message: string };

export const STORAGE_KEY = "pollinations.settings";
