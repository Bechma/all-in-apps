import {describe, expect, test} from 'bun:test';
import {create, fromBinary, type MessageInitShape, toBinary} from '@bufbuild/protobuf';
import {
	CreateNoteRequestSchema,
	CreateNoteResponseSchema,
	DeleteNoteResponseSchema,
	GetNoteResponseSchema,
	ListNotesResponseSchema,
	type NoteDelta,
	UpdateNoteRequestSchema,
	UpdateNoteResponseSchema
} from '$lib/protobuf/gen/notes_pb';
import {subscribeNoteEvents} from '$lib/api/notes';

const baseUrl = process.env.NOTES_API_BASE_URL ?? 'http://127.0.0.1:3000';
const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

const api = {
    createNote: (payload: MessageInitShape<typeof CreateNoteRequestSchema>) =>
        requestProtobuf(
            'POST',
            '/api/notes',
            (binary) => fromBinary(CreateNoteResponseSchema, binary),
            toBinary(CreateNoteRequestSchema, create(CreateNoteRequestSchema, payload))
        ),
    getNote: (noteId: bigint) =>
        requestProtobuf('GET', `/api/notes/${noteId}`, (binary) => fromBinary(GetNoteResponseSchema, binary)),
    updateNote: (noteId: bigint, payload: MessageInitShape<typeof UpdateNoteRequestSchema>) =>
        requestProtobuf(
            'PATCH',
            `/api/notes/${noteId}`,
            (binary) => fromBinary(UpdateNoteResponseSchema, binary),
            toBinary(UpdateNoteRequestSchema, create(UpdateNoteRequestSchema, payload))
        ),
    listNotes: () => requestProtobuf('GET', '/api/notes', (binary) => fromBinary(ListNotesResponseSchema, binary)),
    deleteNote: (noteId: bigint) =>
        requestProtobuf('DELETE', `/api/notes/${noteId}`, (binary) => fromBinary(DeleteNoteResponseSchema, binary))
};

describe('notes backend smoke', () => {
    test(
        'supports create/get/update/list/delete and websocket update events',
        async () => {
            const runId = Date.now();
            const title = `ui-smoke-${runId}`;
            const updatedTitle = `${title}-updated`;
            const body = 'created from ui smoke test';
            const updatedBody = 'updated from ui smoke test';

            const created = await api.createNote({title, body});
            if (created.note === undefined) {
                throw new Error('create response did not include note');
            }

            const noteId = created.note.id;
            expect(created.note.title).toEqual(title);
            expect(created.note.body).toEqual(body);

            const fetched = await api.getNote(noteId);
            expect(fetched.note).toBeTruthy();
            expect(fetched.note!.title).toEqual(title);

            const updatedEvent = waitForUpdatedEvent(noteId);
            const updated = await api.updateNote(noteId, {title: updatedTitle, body: updatedBody});
            expect(updated.note).toBeTruthy();
            expect(updated.note!.title).toEqual(updatedTitle);
            expect(updated.note!.body).toEqual(updatedBody);

            const delta = await updatedEvent;
            expect(delta.title).toEqual(updatedTitle);
            expect(delta.body).toEqual(updatedBody);

            const listed = await api.listNotes();
            const listedNote = listed.notes.find((note) => note.id === noteId);
            expect(listedNote).toBeTruthy();
            expect(listedNote!.title).toEqual(updatedTitle);

            const deleted = await api.deleteNote(noteId);
            expect(deleted.id).toEqual(noteId);

            let gotExpectedDeleteFailure = false;
            try {
                await api.getNote(noteId);
            } catch {
                gotExpectedDeleteFailure = true;
            }
            expect(gotExpectedDeleteFailure).toBe(true);
        },
        15_000
    );
});

async function waitForUpdatedEvent(noteId: bigint): Promise<NoteDelta> {
    return await new Promise((resolve, reject) => {
        let done = false;
        const timeoutId = setTimeout(() => {
            finish(() => reject(new Error('timed out waiting for websocket note update event')));
        }, 5000);

        const unsubscribe = subscribeNoteEvents(
            (event) => {
                if (done || event.event.case !== 'updated') {
                    return;
                }

                const delta = event.event.value as NoteDelta | undefined;
                if (delta?.id === noteId) {
                    finish(() => resolve(delta));
                }
            },
            {baseUrl},
            {
                onError: (error) => {
                    if (!done) {
                        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
                    }
                }
            }
        );

        function finish(callback: () => void): void {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timeoutId);
            unsubscribe();
            callback();
        }
    });
}

async function requestProtobuf<TResponse>(
    method: string,
    path: string,
    decode: (binary: Uint8Array) => TResponse,
    body?: Uint8Array
): Promise<TResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : {'content-type': PROTOBUF_CONTENT_TYPE},
        body: body === undefined ? undefined : toRequestBody(body)
    });

    if (!response.ok) {
        throw new Error(`${method} ${path} failed with ${response.status}`);
    }

    return decode(new Uint8Array(await response.arrayBuffer()));
}

function toRequestBody(payload: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    return copy.buffer;
}
