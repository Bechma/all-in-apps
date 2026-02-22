import {describe, expect, test} from 'bun:test';
import {createNotesApiClient} from '$lib';

const baseUrl = process.env.NOTES_API_BASE_URL ?? 'http://127.0.0.1:3000';
const api = createNotesApiClient({baseUrl});

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
            expect(created.note).toBeTruthy();

            const noteId = created.note!.id;
            expect(created.note!.title).toEqual(title);
            expect(created.note!.body).toEqual(body);

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

async function waitForUpdatedEvent(noteId: bigint): Promise<{
    id: bigint;
    title?: string;
    body?: string;
}> {
    return await new Promise((resolve, reject) => {
        let done = false;
        const timeoutId = setTimeout(() => {
            finish(() => reject(new Error('timed out waiting for websocket note update event')));
        }, 5000);

        const unsubscribe = api.subscribeNoteEvents(
            (event) => {
                if (done || event.event.case !== 'updated') {
                    return;
                }
                if (event.event.value.id === noteId) {
                    finish(() => resolve(event.event.value!));
                }
            },
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
