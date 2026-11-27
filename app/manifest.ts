// Fork: web app manifest for the installable PWA (docs/MOBILE_PWA.md).
// Served at /manifest.webmanifest; the remote gate lets it load before pairing.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		id: "/",
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		orientation: "any",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
