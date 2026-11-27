// Fork: Remote Access. The pairing page. A route handler, not a page.tsx, so it
// renders outside the app shell (whose sidebar and event stream would call
// APIs that are refused before pairing).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Pair this device · LearnHarness</title>
<style>
	:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
	body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: max(1.5rem, env(safe-area-inset-top)) 1.25rem; box-sizing: border-box; }
	main { width: 100%; max-width: 24rem; }
	h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
	p { line-height: 1.5; margin: 0 0 1.25rem; opacity: .85; }
	label { display: block; font-weight: 600; margin-bottom: .5rem; }
	input { width: 100%; box-sizing: border-box; font: 600 1.6rem ui-monospace, monospace; letter-spacing: .25em; text-transform: uppercase; text-align: center; padding: .75rem; border-radius: .75rem; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
	button { margin-top: 1rem; width: 100%; min-height: 3rem; font: 600 1rem system-ui, sans-serif; border-radius: .75rem; border: 0; background: #2563eb; color: #fff; }
	button:disabled { opacity: .6; }
	#message { min-height: 1.5rem; margin-top: 1rem; }
	#message.error { color: #dc2626; }
</style>
</head>
<body>
<main>
	<h1>Pair this device</h1>
	<p>On your computer, open LearnHarness → Settings → Remote Access and choose <b>Pair a device</b>. Enter the 8-character code it shows.</p>
	<form id="pair">
		<label for="code">Pairing code</label>
		<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="9" required inputmode="text" enterkeyhint="go">
		<button id="submit" type="submit">Pair</button>
		<div id="message" role="status" aria-live="polite"></div>
	</form>
</main>
<script>
(function () {
	var form = document.getElementById("pair");
	var input = document.getElementById("code");
	var button = document.getElementById("submit");
	var message = document.getElementById("message");
	function returnPath() {
		var next = new URLSearchParams(location.search).get("next") || "/";
		return next.charAt(0) === "/" && next.charAt(1) !== "/" && next.charAt(1) !== "\\\\" ? next : "/";
	}
	input.focus();
	form.addEventListener("submit", function (event) {
		event.preventDefault();
		button.disabled = true;
		message.className = "";
		message.textContent = "Pairing…";
		fetch("/api/remote-access/pair", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: input.value }),
			credentials: "same-origin",
		}).then(function (response) {
			return response.json().catch(function () { return {}; }).then(function (body) {
				if (response.ok) { message.textContent = "Paired. Opening LearnHarness…"; location.replace(returnPath()); return; }
				message.className = "error";
				message.textContent = body.error || "Pairing failed.";
				button.disabled = false;
			});
		}, function () {
			message.className = "error";
			message.textContent = "Could not reach your computer. Check that LearnHarness and Tailscale are running.";
			button.disabled = false;
		});
	});
})();
</script>
</body>
</html>
`;

export function GET(): Response {
	return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
