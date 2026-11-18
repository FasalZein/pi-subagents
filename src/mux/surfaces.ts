import type { SurfaceCreationOptions, SurfaceSplitDirection } from "./backend.ts";
import { getMuxBackend, muxBackendAdapter, requireMuxBackend } from "./core.ts";

// ── Surface creation ───────────────────────────────────────────────────────

export async function createSurface(name: string, options?: SurfaceCreationOptions): Promise<string> {
	const backend = getMuxBackend();
	if (backend) return muxBackendAdapter(backend).createSurface(name, options);
	return createSurfaceSplit(name, "right");
}

export function createSurfaceSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string {
	return muxBackendAdapter(requireMuxBackend()).createSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	muxBackendAdapter(requireMuxBackend()).renameCurrentTab(title);
}

export function renameWorkspace(title: string): void {
	muxBackendAdapter(requireMuxBackend()).renameWorkspace(title);
}
