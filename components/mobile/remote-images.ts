"use client";
// Fork: phone image attachments (remote browsers only). Images the learner
// picked for the chat whose composer is on screen. The chat reads them into
// the existing `images` field of its text send and clears them only when the
// server accepts the message, so a failed send keeps them.
import { useEffect, useSyncExternalStore } from "react";
import { isRemoteBrowser } from "./browser-mode.ts";

export const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_SIDE_PX = 2048;
const JPEG_QUALITY = 0.85;

export interface PickedImage {
	id: string;
	/** Same shape as the chat wire's image content. */
	data: string;
	mimeType: "image/jpeg";
	previewURL: string;
}

interface ImageState {
	chatId: string | null;
	images: PickedImage[];
}

let state: ImageState = { chatId: null, images: [] };
const listeners = new Set<() => void>();

function publish(next: ImageState) {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The chat page calls this while mounted; images belong to that chat only. */
export function setImageTargetChat(chatId: string | null): void {
	if (state.chatId === chatId) return;
	for (const image of state.images) URL.revokeObjectURL(image.previewURL);
	publish({ chatId, images: [] });
}

/** For the chat's text send: the picked images of this chat, in the wire shape. */
export function pickedImagesForChat(chatId: string): { type: "image"; data: string; mimeType: string }[] {
	if (state.chatId !== chatId) return [];
	return state.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

export function clearPickedImages(chatId: string): void {
	if (state.chatId !== chatId || state.images.length === 0) return;
	for (const image of state.images) URL.revokeObjectURL(image.previewURL);
	publish({ chatId, images: [] });
}

export function removePickedImage(id: string): void {
	const image = state.images.find((entry) => entry.id === id);
	if (!image) return;
	URL.revokeObjectURL(image.previewURL);
	publish({ ...state, images: state.images.filter((entry) => entry.id !== id) });
}

export function usePickedImageState(): ImageState {
	return useSyncExternalStore(subscribe, () => state, () => state);
}

/** The chat page: picked images belong to this chat while it is on screen. */
export function useImageTargetChat(chatId: string): void {
	useEffect(() => {
		setImageTargetChat(chatId);
		return () => setImageTargetChat(null);
	}, [chatId]);
}

/** The session composer shows the phone image button only in a remote browser on a chat page. */
export function useRemoteImageAttach(): { available: boolean; count: number } {
	const current = useSyncExternalStore(subscribe, () => state, () => null);
	const available = current !== null && current.chatId !== null && isRemoteBrowser();
	return { available, count: available ? current.images.length : 0 };
}

/** Phone photos are large and may be HEIC; re-encode as a JPEG no bigger than MAX_IMAGE_SIDE_PX. */
async function encodeAsJPEG(file: File): Promise<{ data: string; blob: Blob }> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_IMAGE_SIDE_PX / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("encode failed"))), "image/jpeg", JPEG_QUALITY));
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return { data: btoa(binary), blob };
}

/** Adds files to the current chat. Returns how many could not be read as images. */
export async function addPickedImageFiles(files: File[]): Promise<{ skipped: number; overLimit: boolean }> {
	const chatId = state.chatId;
	if (!chatId) return { skipped: files.length, overLimit: false };
	let skipped = 0;
	let overLimit = false;
	for (const file of files) {
		if (state.chatId !== chatId) break;
		if (state.images.length >= MAX_IMAGES_PER_MESSAGE) { overLimit = true; break; }
		try {
			const { data, blob } = await encodeAsJPEG(file);
			publish({ ...state, images: [...state.images, { id: crypto.randomUUID(), data, mimeType: "image/jpeg", previewURL: URL.createObjectURL(blob) }] });
		} catch {
			skipped++;
		}
	}
	return { skipped, overLimit };
}
