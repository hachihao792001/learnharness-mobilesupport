"use client";
// Fork: a searchable list of the knowledge graph's propositions, for screens
// where the canvas is hard to use. Same data as the canvas (GET /api/graph);
// tapping a node shows its statement and the sessions that touched it.
import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { GraphSnapshot } from "@/src/core";

type GraphListData = Pick<GraphSnapshot, "propositions" | "sessions" | "nodeSessions">;

export function filterGraphNodes(graph: GraphListData, query: string) {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return graph.propositions
		.filter((node) => {
			const text = `${node.name} ${node.statement}`.toLowerCase();
			return words.every((word) => text.includes(word));
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function GraphNodeList({ onOpenSession }: { onOpenSession: (chatId: string) => void }) {
	const [graph, setGraph] = useState<GraphListData | null>(null);
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [openNodeId, setOpenNodeId] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		fetch("/api/graph", { cache: "no-store" })
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((snapshot: GraphSnapshot) => { if (live) setGraph(snapshot); })
			.catch(() => { if (live) setFailed(true); });
		return () => { live = false; };
	}, []);

	const nodes = useMemo(() => (graph ? filterGraphNodes(graph, query) : []), [graph, query]);

	if (failed) return <p className="p-4 text-sm text-muted-foreground">The graph could not be loaded. Check the connection and try again.</p>;
	if (!graph) return <p className="p-4 text-sm text-muted-foreground">Loading the graph…</p>;

	return (
		<div className="flex flex-col" data-testid="graph-node-list">
			<div className="sticky top-0 border-b border-border bg-card p-3">
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={`Search ${graph.propositions.length} nodes…`}
					aria-label="Search nodes"
					enterKeyHint="search"
					className="h-11 w-full rounded-md border border-border bg-background px-3 text-base outline-none"
				/>
			</div>
			{nodes.length === 0 && <p className="p-4 text-sm text-muted-foreground">{graph.propositions.length === 0 ? "The graph is empty. Learning sessions add nodes as you go." : "No node matches."}</p>}
			<ul>
				{nodes.map((node) => {
					const open = openNodeId === node.id;
					const sessionIds = graph.nodeSessions[node.id] ?? [];
					return (
						<li key={node.id} className="border-b border-border/60">
							<button
								type="button"
								aria-expanded={open}
								onClick={() => setOpenNodeId(open ? null : node.id)}
								className="flex min-h-12 w-full items-center gap-2 px-4 py-2 text-left"
							>
								<ChevronRightIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
								<span className="min-w-0 flex-1 font-prose">{node.name}</span>
								{sessionIds.length > 0 && <span className="text-xs text-muted-foreground">{sessionIds.length}</span>}
							</button>
							{open && (
								<div className="px-4 pb-3 pl-10">
									<p className="font-prose text-sm leading-relaxed">{node.statement}</p>
									{sessionIds.length > 0 && (
										<div className="mt-2 flex flex-col gap-1">
											{sessionIds.map((chatId) => (
												<button key={chatId} type="button" onClick={() => onOpenSession(chatId)} className="min-h-10 rounded-md px-2 text-left text-sm text-primary underline-offset-2 hover:underline">
													{graph.sessions[chatId] ?? "Untitled session"}
												</button>
											))}
										</div>
									)}
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
