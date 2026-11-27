// Fork: writes one synthetic chat for scripts/fork/smoke-mobile.mjs, using
// the app's own store (so the format is always the current one).
// Usage: LH_DATA_DIR=<scratch dir> node --import tsx scripts/fork/seed-mobile-fixture.ts
// Prints {"chatId": "..."}. Never point LH_DATA_DIR at real learning data.

export {};

if (!process.env.LH_DATA_DIR) throw new Error("Set LH_DATA_DIR to a scratch directory.");

const { createChat } = await import("../../src/server/chats.ts");
const { chatStore } = await import("../../src/store/chats.ts");

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const longParagraph = "A proposition is one true, self-contained statement. ".repeat(40);
const wideCode = "```ts\nexport function veryLongFunctionNameForMobileLayoutChecks(parameterNumberOne: string, parameterNumberTwo: number, parameterNumberThree: boolean): string { return `${parameterNumberOne}-${parameterNumberTwo}-${parameterNumberThree}`; }\n```";
const wideTable = [
	"| Concept | Definition | Example | Counter-example | Source | Confidence | Last reviewed |",
	"|---|---|---|---|---|---|---|",
	"| Modus ponens | If P then Q; P; therefore Q | Rain → wet street | Affirming the consequent | Logic notes, chapter 2 | High | 2026-11-20 |",
	"| Modus tollens | If P then Q; not Q; therefore not P | Dry street → no rain | Denying the antecedent | Logic notes, chapter 2 | Medium | 2026-11-21 |",
].join("\n");

const chat = createChat("Mobile layout fixture");
chatStore.saveMessages(chat.id, [
	{ id: "fixture-user-1", role: "user", content: [{ type: "text", text: "Explain modus ponens with a table and some code." }], timestamp: 1 },
	{
		id: "fixture-assistant-1", role: "assistant", api: "openai-completions", provider: "openrouter", model: "fixture", stopReason: "stop", timestamp: 2, usage,
		content: [{ type: "text", text: `${longParagraph}\n\n${wideCode}\n\n${wideTable}\n\nA long link: https://example.com/${"very-long-path-segment/".repeat(12)}` }],
	},
	{ id: "fixture-user-2", role: "user", content: [{ type: "text", text: "Thanks!" }], timestamp: 3 },
] as never);

console.log(JSON.stringify({ chatId: chat.id }));
