/**
 * Pasted images are represented in the editor as `[image #N]` markers while the
 * image bytes are held aside in a registry keyed by N. The markers present in
 * the submitted text decide which images are attached to the prompt, so deleting
 * a marker drops its image and restoring it (undo, history, retry) brings it back
 * as long as the bytes are still in the registry.
 */

/** Matches `[image #N]` markers inserted when an image is pasted into the editor. */
const IMAGE_MARKER_REGEX = /\[image #(\d+)\]/g;

/** The marker text inserted into the editor for pasted image `id`. */
export function formatImageMarker(id: number): string {
	return `[image #${id}]`;
}

/** Marker ids that appear in `text`, in order of appearance. */
export function imageMarkerIds(text: string): number[] {
	return [...text.matchAll(IMAGE_MARKER_REGEX)].map((match) => Number(match[1]));
}

/**
 * Images from `pending` whose marker still appears in `text`, in paste order
 * (the map's insertion order). Each image is returned at most once even if its
 * marker is duplicated in the text.
 */
export function collectMarkedImages<T>(pending: ReadonlyMap<number, T>, text: string): T[] {
	if (pending.size === 0) {
		return [];
	}
	const present = new Set(imageMarkerIds(text));
	const images: T[] = [];
	for (const [id, image] of pending) {
		if (present.has(id)) {
			images.push(image);
		}
	}
	return images;
}
