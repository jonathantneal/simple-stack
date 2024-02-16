import {
	type SuspenseGlobalCtx,
	createSuspenseResponse,
} from "./suspense-context";
import { defineMiddleware } from "astro:middleware";

type SuspendedChunk = {
	id: number;
	chunk: string;
};

export const onRequest = defineMiddleware(async (ctx, next) => {
	let streamController: ReadableStreamDefaultController<SuspendedChunk>;

	// Thank you owoce!
	// https://gist.github.com/lubieowoce/05a4cb2e8cd252787b54b7c8a41f09fc
	const stream = new ReadableStream<SuspendedChunk>({
		start(controller) {
			streamController = controller;
		},
	});

	const suspenseCtx: SuspenseGlobalCtx = createSuspenseResponse({
		onAsyncChunkReady(chunk, boundary) {
			const { id } = boundary;
			console.log("middleware :: enqueuing", id);
			streamController.enqueue({ chunk, id });
		},
		onBoundaryErrored(error: unknown) {
			streamController.error(error);
		},
		onAllReady() {
			return streamController.close();
		},
	});

	ctx.locals.suspense = suspenseCtx;

	const response = await next();

	// ignore non-HTML responses
	if (!response.headers.get("content-type")?.startsWith("text/html")) {
		return response;
	}

	async function* render() {
		// @ts-expect-error ReadableStream does not have asyncIterator
		for await (const chunk of response.body) {
			yield chunk;
		}

		if (!suspenseCtx.pending.size) return streamController.close();

		console.log(`middleware :: ${suspenseCtx.pending.size} chunks pending`);
		if (!suspenseCtx.pending.size) return streamController.close();

		yield BOOTSTRAP_SCRIPT_START;

		// @ts-expect-error ReadableStream does not have asyncIterator
		for await (const item of stream) {
			const { id, chunk } = item as SuspendedChunk;
			console.log("middleware :: yielding", id, chunk);
			yield asyncChunkInsertionHTML(id, chunk);
		}

		yield BOOTSTRAP_SCRIPT_END;
	}

	// @ts-expect-error generator not assignable to ReadableStream
	return new Response(render(), response.headers);
});

const BOOTSTRAP_SCRIPT_START = `<script>{
const range = new Range();
const template = document.createElement('template');

range.selectNodeContents(template);

const insertSuspense = (id, content) => {
	try {
		document.querySelector('[data-suspense-fallback="' + id + '"]').replaceWith(
			range.createContextualFragment(content)
		);
	} catch (e) {
		console.error("Failed to insert async content (Suspense boundary id: " + id + ")", e);
	}
};`.replace(/[\n\t]/g, '');

const BOOTSTRAP_SCRIPT_END = `}</script>`

function asyncChunkInsertionHTML(id: number, chunk: string) {
	return (
		`insertSuspense(${id}, ${JSON.stringify(chunk)});`
	);
}
