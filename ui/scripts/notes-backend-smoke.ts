import assert from 'node:assert/strict';
import {createNotesApiClient} from '../src/lib/api/notes';

const baseUrl = process.env.NOTES_API_BASE_URL ?? 'http://127.0.0.1:3000';
const api = createNotesApiClient({baseUrl});

const runId = Date.now();
const title = `ui-smoke-${runId}`;
const updatedTitle = `${title}-updated`;
const body = 'created from ui smoke test';
const updatedBody = 'updated from ui smoke test';

const created = await api.createNote({title, body});
assert.ok(created.note, 'create response must include a note');

const noteId = created.note.id;
assert.equal(created.note.title, title);
assert.equal(created.note.body, body);

const fetched = await api.getNote(noteId);
assert.ok(fetched.note, 'get response must include a note');
assert.equal(fetched.note.title, title);

const updatedEvent = waitForUpdatedEvent(noteId);
const updated = await api.updateNote(noteId, {title: updatedTitle, body: updatedBody});
assert.ok(updated.note, 'update response must include a note');
assert.equal(updated.note.title, updatedTitle);
assert.equal(updated.note.body, updatedBody);

const delta = await updatedEvent;
assert.equal(delta.title, updatedTitle);
assert.equal(delta.body, updatedBody);

const listed = await api.listNotes();
const listedNote = listed.notes.find((note) => note.id === noteId);
assert.ok(listedNote, 'list response should include created note');
assert.equal(listedNote.title, updatedTitle);

const deleted = await api.deleteNote(noteId);
assert.equal(deleted.id, noteId);

let gotExpectedDeleteFailure = false;
try {
    await api.getNote(noteId);
} catch {
    gotExpectedDeleteFailure = true;
}
assert.equal(gotExpectedDeleteFailure, true, 'deleted note should no longer be fetchable');

console.log(`notes backend smoke test passed for ${baseUrl}`);

async function waitForUpdatedEvent(noteId: number): Promise<{
    id: number;
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
                if (done || event.event?.kind !== 'updated') {
                    return;
                }
                if (event.event.delta.id === noteId) {
                    finish(() => resolve(event.event.delta));
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
