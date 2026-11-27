"use client";
// Fork: phone image attachments. Replaces the desktop path-attach button in a
// remote browser's chat composer. Opens the phone's own picker (camera or
// photos); the picked images ride the chat's normal text send.
import { useRef, useState } from "react";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { addPickedImageFiles, MAX_IMAGES_PER_MESSAGE, removePickedImage, usePickedImageState } from "./remote-images.ts";

export function RemoteImageAttachButton() {
	const inputRef = useRef<HTMLInputElement>(null);
	const { images } = usePickedImageState();
	const [notice, setNotice] = useState("");
	const [reading, setReading] = useState(false);

	return (
		<div className="relative shrink-0">
			<input
				ref={inputRef}
				type="file"
				accept="image/*"
				multiple
				hidden
				data-testid="remote-image-input"
				onChange={async (event) => {
					const files = Array.from(event.currentTarget.files ?? []);
					event.currentTarget.value = "";
					if (files.length === 0) return;
					setReading(true);
					const { skipped, overLimit } = await addPickedImageFiles(files);
					setReading(false);
					setNotice(overLimit ? `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images to one message.` : skipped ? "Some files could not be read as images." : "");
				}}
			/>
			{(images.length > 0 || notice) && (
				<div data-testid="remote-image-tray" className="absolute bottom-full right-0 mb-2 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-1">
					{images.length > 0 && (
						<div className="flex gap-2 rounded-lg border border-border bg-card p-1.5 shadow-md">
							{images.map((image) => (
								<div key={image.id} className="relative size-14 shrink-0 overflow-hidden rounded-md border border-border">
									{/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
									<img src={image.previewURL} alt="Attached image" className="size-full object-cover" />
									<button
										type="button"
										aria-label="Remove image"
										onClick={() => removePickedImage(image.id)}
										className="absolute right-0.5 top-0.5 flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground"
									>
										<XIcon className="size-3.5" />
									</button>
								</div>
							))}
						</div>
					)}
					{notice && <p role="status" className="rounded-md bg-card px-2 py-1 text-xs text-muted-foreground shadow">{notice}</p>}
				</div>
			)}
			<button
				type="button"
				aria-label="Attach images"
				data-testid="remote-image-attach"
				disabled={reading}
				onClick={() => { setNotice(""); inputRef.current?.click(); }}
				className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
			>
				<ImagePlusIcon className="size-4" />
				{images.length > 0 && <span className="sr-only">{images.length} attached</span>}
			</button>
		</div>
	);
}
