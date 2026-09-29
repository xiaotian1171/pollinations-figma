"use strict";
(() => {
  // src/shared/api.ts
  function mimeForExtension(extension) {
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
  var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToBase64(bytes) {
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index];
      const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const triple = a << 16 | b << 8 | c;
      output += BASE64_ALPHABET[triple >> 18 & 63];
      output += BASE64_ALPHABET[triple >> 12 & 63];
      output += index + 1 < bytes.length ? BASE64_ALPHABET[triple >> 6 & 63] : "=";
      output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
    }
    return output;
  }

  // src/shared/format.ts
  var LAYER_PREFIX = "Pollinations - ";
  function layerName(prompt, maxLength = 80) {
    const clean = (prompt || "").replace(/\s+/g, " ").trim();
    if (!clean) return "Pollinations";
    const room = Math.max(4, maxLength - LAYER_PREFIX.length - 1);
    const short = clean.length > room ? clean.slice(0, room).trimEnd() + "\u2026" : clean;
    return LAYER_PREFIX + short;
  }
  function placementFor(viewportCenter, width, height) {
    return {
      x: Math.round(viewportCenter.x - width / 2),
      y: Math.round(viewportCenter.y - height / 2)
    };
  }

  // src/shared/messages.ts
  var STORAGE_KEY = "pollinations.settings";

  // src/code.ts
  figma.showUI(__html__, { width: 400, height: 660, themeColors: true });
  var PAGE = figma.currentPage;
  function post(message) {
    figma.ui.postMessage(message);
  }
  function imageHashOf(node) {
    if (!("fills" in node)) return "";
    const fills = node.fills;
    if (!fills || fills === figma.mixed || !Array.isArray(fills)) return "";
    for (const paint of fills) {
      if (paint.type === "IMAGE") {
        const hash = paint.imageHash;
        if (hash) return hash;
      }
    }
    return "";
  }
  function summarise(nodes) {
    return nodes.map((node) => ({
      name: node.name,
      type: node.type,
      width: "width" in node ? node.width : 0,
      height: "height" in node ? node.height : 0,
      hasImageFill: imageHashOf(node) !== ""
    }));
  }
  function sendSelection() {
    post({ type: "selection", nodes: summarise(PAGE.selection) });
  }
  var DEFAULT_SETTINGS = {
    apiKey: "",
    appKey: "",
    model: "",
    width: 1024,
    height: 1024,
    seed: -1,
    scaleMode: "FILL",
    nologo: false,
    safe: false,
    prompt: ""
  };
  async function loadSettings() {
    let stored = {};
    try {
      const value = await figma.clientStorage.getAsync(STORAGE_KEY);
      if (value && typeof value === "object") stored = value;
    } catch (e) {
      stored = {};
    }
    post({ type: "settings", settings: Object.assign({}, DEFAULT_SETTINGS, stored) });
  }
  async function saveSettings(settings) {
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY, Object.assign({}, DEFAULT_SETTINGS, settings));
    } catch (e) {
      post({ type: "error", message: "Figma refused to store the plugin settings." });
    }
  }
  function placementForNewLayer(selection, width, height) {
    const only = selection.length === 1 ? selection[0] : null;
    const box = only && only.absoluteBoundingBox ? only.absoluteBoundingBox : null;
    if (box) {
      return { x: Math.round(box.x + box.width + 40), y: Math.round(box.y) };
    }
    return placementFor(figma.viewport.center, width, height);
  }
  function imagePaint(imageHash, scaleMode) {
    return { type: "IMAGE", scaleMode, imageHash };
  }
  function hasFills(node) {
    return "fills" in node;
  }
  async function placeImage(message) {
    const bytes = base64ToBytes(message.base64);
    if (bytes.length === 0) {
      post({ type: "error", message: "The generated image came back empty." });
      return;
    }
    const image = figma.createImage(bytes);
    const selection = PAGE.selection.slice();
    const fillTargets = message.target === "selection" ? selection.filter((node) => hasFills(node)) : [];
    if (message.target === "selection" && fillTargets.length === 0) {
      post({ type: "error", message: "Fill needs a layer that supports fills (a frame, shape or text layer)." });
      return;
    }
    if (fillTargets.length > 0) {
      for (const node of fillTargets) {
        node.fills = [imagePaint(image.hash, message.scaleMode)];
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
  function base64ToBytes(base64) {
    if (!base64) return new Uint8Array(0);
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
    const length = Math.floor(clean.length * 3 / 4);
    const bytes = new Uint8Array(length);
    let byteIndex = 0;
    let buffer = 0;
    let bits = 0;
    for (let index = 0; index < clean.length; index++) {
      const value = table.indexOf(clean[index]);
      if (value < 0) continue;
      buffer = buffer << 6 | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[byteIndex++] = buffer >> bits & 255;
      }
    }
    return bytes.slice(0, byteIndex);
  }
  async function sendSelectionImage() {
    const selection = PAGE.selection;
    let node = null;
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
        name: node.name
      });
    } catch (e) {
      post({ type: "selection-image-missing" });
    }
  }
  function imageExtensionFromBytes(bytes) {
    if (bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80) return "png";
    if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216) return "jpg";
    if (bytes.length > 12 && bytes[8] === 87 && bytes[9] === 69) return "webp";
    if (bytes.length > 3 && bytes[0] === 71 && bytes[1] === 73) return "gif";
    return "png";
  }
  figma.ui.onmessage = (message) => {
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
})();
