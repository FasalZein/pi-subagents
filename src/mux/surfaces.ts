import type { SurfaceCreationOptions, SurfaceSplitDirection } from "./backend.ts";
import { getMuxBackend, muxBackendAdapter, requireMuxBackend } from "./core.ts";
import {
	createHerdrSplit,
	createHerdrSurface,
	renameHerdrCurrentTab,
	renameHerdrCurrentWorkspace,
} from "./herdr-surfaces.ts";

// ── Surface creation ───────────────────────────────────────────────────────

export async function createSurface(name: string, options?: SurfaceCreationOptions): Promise<string> {
	const backend = getMuxBackend();
	const adapter = backend ? muxBackendAdapter(backend) : undefined;
	if (adapter) return adapter.createSurface(name, options);
	if (backend === "herdr") return createHerdrSurface(name, options?.herdr);
	return createSurfaceSplit(name, "right");
}

export function createSurfaceSplit(name: string, direction: SurfaceSplitDirection, fromSurface?: string): string {
	const adapter = muxBackendAdapter(requireMuxBackend());
	return adapter ? adapter.createSplit(name, direction, fromSurface) : createHerdrSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	const adapter = muxBackendAdapter(requireMuxBackend());
	if (adapter) adapter.renameCurrentTab(title);
	else renameHerdrCurrentTab(title);
}

export function renameWorkspace(title: string): void {
	const adapter = muxBackendAdapter(requireMuxBackend());
	if (adapter) adapter.renameWorkspace(title);
	else renameHerdrCurrentWorkspace(title);
}
