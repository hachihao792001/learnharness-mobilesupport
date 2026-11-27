#!/usr/bin/env node
// Fork: PWA icons (docs/MOBILE_PWA.md). Renders public/icons/*.png from the
// desktop app's own artwork (build/icon-flat.svg) with the resvg renderer the
// app already depends on. Run again only if the artwork changes; the PNGs are
// committed.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = await readFile(path.join(repo, "build", "icon-flat.svg"), "utf8");
const outDir = path.join(repo, "public", "icons");
// The dark theme's page background (app/globals.css --background).
const BACKGROUND = "#141414";

const inner = source.slice(source.indexOf(">", source.indexOf("<svg")) + 1, source.lastIndexOf("</svg>"));
/** The artwork centred at `scale` on a solid square: maskable icons must keep their content inside the middle 80%. */
const onBackground = (scale) => {
	const offset = (1024 * (1 - scale)) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${inner}</g></svg>`;
};

const icons = [
	{ file: "icon-192.png", svg: source, size: 192 },
	{ file: "icon-512.png", svg: source, size: 512 },
	{ file: "icon-maskable-512.png", svg: onBackground(0.7), size: 512 },
	// iOS fills transparency with black and rounds the corners itself.
	{ file: "apple-touch-icon.png", svg: onBackground(0.86), size: 180 },
];

await mkdir(outDir, { recursive: true });
for (const icon of icons) {
	const png = new Resvg(icon.svg, { fitTo: { mode: "width", value: icon.size } }).render().asPng();
	await writeFile(path.join(outDir, icon.file), png);
	console.log(`[pwa-icons] ${icon.file} ${icon.size}px (${png.length} bytes)`);
}
