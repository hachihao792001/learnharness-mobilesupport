// Fork: Remote Access. A short, plain name for a paired device, shown in the
// desktop device list so the user can tell phones apart when revoking.

const PLATFORMS: [RegExp, string][] = [
	[/iPhone/, "iPhone"],
	[/iPad/, "iPad"],
	[/Android/, "Android"],
	[/Windows/, "Windows"],
	[/Macintosh|Mac OS X/, "Mac"],
	[/CrOS/, "ChromeOS"],
	[/Linux/, "Linux"],
];

// Order matters: Edge and Samsung Internet also say "Chrome"; Chrome also says "Safari".
const BROWSERS: [RegExp, string][] = [
	[/EdgA?\//, "Edge"],
	[/SamsungBrowser\//, "Samsung Internet"],
	[/Firefox\/|FxiOS\//, "Firefox"],
	[/CriOS\/|Chrome\//, "Chrome"],
	[/Safari\//, "Safari"],
];

export function deviceLabelFromUserAgent(userAgent: string | null): string {
	if (!userAgent) return "Browser";
	const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Browser";
	return platform ? `${browser} on ${platform}` : browser;
}
