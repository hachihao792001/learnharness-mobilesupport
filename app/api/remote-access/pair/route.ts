// Fork: Remote Access (docs/REMOTE_ACCESS_ARCHITECTURE.md).
import { remoteAccessPairResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return remoteAccessPairResponse(request); }
