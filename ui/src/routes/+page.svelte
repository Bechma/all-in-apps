<script lang="ts">
    import {onMount} from 'svelte';
    import {useQueryClient} from '@tanstack/svelte-query';
    import {
        applyNoteEventToCache,
        createCreateNoteMutation,
        createDeleteNoteMutation,
        createNotesQuery,
        createUpdateNoteMutation,
        subscribeNoteEvents
    } from '$lib/api/notes';
    import type {NoteDelta, NoteEvent} from '$lib/protobuf/gen/notes_pb';

    const queryClient = useQueryClient();
    const notesQuery = createNotesQuery();
    const createNoteMutation = createCreateNoteMutation();
    const updateNoteMutation = createUpdateNoteMutation();
    const deleteNoteMutation = createDeleteNoteMutation();

    let selectedNoteId = $state<bigint | null>(null);
    let draftTitle = $state('');
    let draftBody = $state('');
    let newTitle = $state('');
    let newBody = $state('');
    let localErrorMessage = $state<string | null>(null);
    let realtimeState = $state<'connecting' | 'connected' | 'disconnected'>('connecting');

    let notes = $derived(notesQuery.data ?? []);
    let selectedNote = $derived(notes.find((note) => note.id === selectedNoteId) ?? null);
    let noteCountLabel = $derived(notes.length === 1 ? '1 note' : `${notes.length} notes`);
    let isLoading = $derived(notesQuery.isLoading);
    let isRefreshing = $derived(notesQuery.isFetching);
    let isCreating = $derived(createNoteMutation.isPending);
    let isSaving = $derived(updateNoteMutation.isPending);
    let isDeleting = $derived(deleteNoteMutation.isPending);
    let hasUnsavedChanges = $derived(
        selectedNote !== null && (draftTitle !== selectedNote.title || draftBody !== selectedNote.body)
    );
    let canCreate = $derived(newTitle.trim().length > 0 && !isCreating);
    let canSave = $derived(selectedNote !== null && draftTitle.trim().length > 0 && hasUnsavedChanges && !isSaving);
    let errorMessage = $derived(
        localErrorMessage ??
        toErrorMessage(notesQuery.error) ??
        toErrorMessage(createNoteMutation.error) ??
        toErrorMessage(updateNoteMutation.error) ??
        toErrorMessage(deleteNoteMutation.error)
    );
    const AUTO_SAVE_DELAY_MS = 200;

    $effect(() => {
        if (notes.length === 0) {
            if (selectedNoteId !== null) {
                selectNote(null);
            }
            return;
        }

        if (selectedNoteId === null) {
            selectNote(notes[0].id);
            return;
        }

        const selectionStillExists = notes.some((note) => note.id === selectedNoteId);
        if (!selectionStillExists) {
            selectNote(notes[0].id);
        }
    });

    $effect(() => {
        if (selectedNote === null || isSaving || !hasUnsavedChanges || draftTitle.trim().length === 0) {
            return;
        }

        const timeoutId = setTimeout(() => {
            void saveSelectedNote();
        }, AUTO_SAVE_DELAY_MS);

        return () => {
            clearTimeout(timeoutId);
        };
    });

    onMount(() => {
        const unsubscribe = subscribeNoteEvents(
            handleRealtimeEvent,
            {},
            {
                onOpen: () => {
                    realtimeState = 'connected';
                },
                onClose: () => {
                    realtimeState = 'disconnected';
                },
                onError: (error: unknown) => {
                    realtimeState = 'disconnected';
                    if (!isLoading) {
                        localErrorMessage = toErrorMessage(error) ?? 'Unexpected error';
                    }
                }
            }
        );

        return () => {
            unsubscribe();
        };
    });

    async function refreshNotes(): Promise<void> {
        try {
            localErrorMessage = null;
            await notesQuery.refetch();
        } catch (error) {
            localErrorMessage = toErrorMessage(error) ?? 'Unexpected error';
        }
    }

    async function createNote(): Promise<void> {
        const title = newTitle.trim();
        if (!title) {
            localErrorMessage = 'Title is required';
            return;
        }

        try {
            localErrorMessage = null;
            const note = await createNoteMutation.mutateAsync({
                title,
                body: newBody
            });
            selectedNoteId = note.id;
            draftTitle = note.title;
            draftBody = note.body;
            newTitle = '';
            newBody = '';
        } catch (error) {
            localErrorMessage = toErrorMessage(error) ?? 'Unexpected error';
        }
    }

    async function saveSelectedNote(): Promise<void> {
        if (selectedNote === null) {
            return;
        }
        if (isSaving) {
            return;
        }

        const title = draftTitle.trim();
        if (!title) {
            localErrorMessage = 'Title is required';
            return;
        }

        const updateRequest = {
            title: title !== selectedNote.title ? title : undefined,
            body: draftBody !== selectedNote.body ? draftBody : undefined
        };

        if (updateRequest.title === undefined && updateRequest.body === undefined) {
            return;
        }

        try {
            localErrorMessage = null;
            await updateNoteMutation.mutateAsync({
                noteId: selectedNote.id,
                request: updateRequest
            });
        } catch (error) {
            localErrorMessage = toErrorMessage(error) ?? 'Unexpected error';
        }
    }

    async function deleteSelectedNote(): Promise<void> {
        if (selectedNote === null) {
            return;
        }

        const shouldDelete = window.confirm(`Delete "${selectedNote.title}"?`);
        if (!shouldDelete) {
            return;
        }

        try {
            localErrorMessage = null;
            await deleteNoteMutation.mutateAsync(selectedNote.id);
        } catch (error) {
            localErrorMessage = toErrorMessage(error) ?? 'Unexpected error';
        }
    }

    function handleRealtimeEvent(event: NoteEvent): void {
        if (event.event.case === 'updated') {
            const delta = event.event.value;
            if (delta === undefined) {
                return;
            }
            const shouldSyncEditor = !hasUnsavedChanges && selectedNoteId === delta.id;
            if (shouldSyncEditor) {
                applyDraftDelta(delta);
            }
        }

        applyNoteEventToCache(queryClient, event);
    }

    function applyDraftDelta(delta: NoteDelta): void {
        if (delta.title !== undefined) {
            draftTitle = delta.title;
        }
        if (delta.body !== undefined) {
            draftBody = delta.body;
        }
    }

    function selectNote(noteId: bigint | null): void {
        selectedNoteId = noteId;
        const note = noteId === null ? null : notes.find((candidate) => candidate.id === noteId) ?? null;
        draftTitle = note?.title ?? '';
        draftBody = note?.body ?? '';
    }

    function toErrorMessage(error: unknown): string | null {
        if (error instanceof Error && error.message) {
            return error.message;
        }
        return error === null || error === undefined ? null : 'Unexpected error';
    }

    function formatTimestamp(unixMs: bigint): string {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(new Date(Number(unixMs)));
    }
</script>

<svelte:head>
    <title>Notes Studio</title>
</svelte:head>

<main class="shell">
    <header class="topbar">
        <div>
            <p class="kicker">Notes</p>
            <h1>Studio</h1>
        </div>
        <div class="meta">
            <span>{noteCountLabel}</span>
            <span class={`status status-${realtimeState}`}>{realtimeState}</span>
        </div>
    </header>

    {#if errorMessage}
        <p class="error">{errorMessage}</p>
    {/if}

    <div class="workspace">
        <section class="panel catalog">
            <form
                    class="new-note"
                    onsubmit={(event) => {
					event.preventDefault();
					void createNote();
				}}
            >
                <h2>New note</h2>
                <label>
                    Title
                    <input
                            type="text"
                            bind:value={newTitle}
                            placeholder="Meeting notes"
                            maxlength={120}
                            required
                    />
                </label>
                <label>
                    Body
                    <textarea bind:value={newBody} rows="4" placeholder="Write anything..."></textarea>
                </label>
                <button type="submit" disabled={!canCreate}>
                    {isCreating ? 'Creating...' : 'Create note'}
                </button>
            </form>

            <div class="list-header">
                <h2>Library</h2>
                <button type="button" class="quiet" onclick={() => void refreshNotes()} disabled={isRefreshing}>
                    Refresh
                </button>
            </div>

            {#if isLoading}
                <p class="hint">Loading notes...</p>
            {:else}
                <ul class="note-list">
                    {#each notes as note (note.id)}
                        <li>
                            <button
                                    type="button"
                                    class:selected={selectedNoteId === note.id}
                                    onclick={() => selectNote(note.id)}
                            >
                                <strong>{note.title}</strong>
                                <span>{note.body || 'No body content'}</span>
                                <small>v{note.version} • {formatTimestamp(note.updatedAtUnixMs)}</small>
                            </button>
                        </li>
                    {:else}
                        <li class="hint">No notes yet. Create your first note.</li>
                    {/each}
                </ul>
            {/if}
        </section>

        <section class="panel editor">
            {#if selectedNote !== null}
                <form
                        class="editor-form"
                        onsubmit={(event) => {
						event.preventDefault();
						void saveSelectedNote();
					}}
                >
                    <div class="editor-head">
                        <h2>Editing note #{selectedNote.id}</h2>
                        <div class="actions">
                            <button type="submit" disabled={!canSave}>
                                {isSaving ? 'Saving...' : hasUnsavedChanges ? 'Save changes' : 'Saved'}
                            </button>
                            <button
                                    type="button"
                                    class="danger"
                                    onclick={() => void deleteSelectedNote()}
                                    disabled={isDeleting}
                            >
                                {isDeleting ? 'Deleting...' : 'Delete'}
                            </button>
                        </div>
                    </div>

                    <label>
                        Title
                        <input type="text" bind:value={draftTitle} maxlength={120} required/>
                    </label>
                    <label>
                        Body
                        <textarea bind:value={draftBody} rows="18"></textarea>
                    </label>
                    <p class="hint">
                        Updated {formatTimestamp(selectedNote.updatedAtUnixMs)} • version {selectedNote.version}
                    </p>
                </form>
            {:else}
                <div class="empty">
                    <h2>Pick a note</h2>
                    <p>Select a note from the library, or create one to start writing.</p>
                </div>
            {/if}
        </section>
    </div>
</main>

<style>
    .shell {
        max-width: 1200px;
        margin: 0 auto;
        padding: clamp(1rem, 2vw, 2rem);
    }

    .topbar {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 1rem;
        margin-bottom: 1rem;
    }

    .kicker {
        margin: 0;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-soft);
    }

    h1 {
        margin: 0;
        font-family: var(--font-title), serif;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1;
    }

    .meta {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.85rem;
        color: var(--ink-soft);
    }

    .status {
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        text-transform: uppercase;
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        border: 1px solid color-mix(in oklab, var(--surface-strong), transparent 65%);
    }

    .status-connected {
        background: color-mix(in oklab, #3ecf8e, transparent 78%);
        color: #145a3e;
    }

    .status-connecting {
        background: color-mix(in oklab, #f7be5a, transparent 78%);
        color: #6f4904;
    }

    .status-disconnected {
        background: color-mix(in oklab, #de5f5f, transparent 78%);
        color: #7f2020;
    }

    .error {
        margin: 0 0 1rem 0;
        padding: 0.7rem 0.9rem;
        border-radius: 0.75rem;
        background: color-mix(in oklab, #de5f5f, transparent 86%);
        border: 1px solid color-mix(in oklab, #de5f5f, transparent 65%);
        color: #7f2020;
    }

    .workspace {
        display: grid;
        grid-template-columns: minmax(280px, 360px) 1fr;
        gap: 1rem;
    }

    .panel {
        background: color-mix(in oklab, var(--surface), white 6%);
        backdrop-filter: blur(10px);
        border: 1px solid color-mix(in oklab, var(--surface-strong), transparent 68%);
        border-radius: 1rem;
        padding: 1rem;
        box-shadow: 0 18px 42px -34px rgba(18, 25, 36, 0.55);
    }

    .catalog {
        display: grid;
        gap: 1rem;
        align-content: start;
    }

    .new-note {
        display: grid;
        gap: 0.75rem;
        padding: 0.8rem;
        background: color-mix(in oklab, var(--surface-strong), transparent 86%);
        border: 1px solid color-mix(in oklab, var(--surface-strong), transparent 60%);
        border-radius: 0.8rem;
    }

    .list-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .note-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 0.5rem;
        max-height: 52vh;
        overflow: auto;
    }

    .note-list button {
        width: 100%;
        padding: 0.65rem;
        border-radius: 0.75rem;
        text-align: left;
        display: grid;
        gap: 0.3rem;
        border: 1px solid color-mix(in oklab, var(--surface-strong), transparent 70%);
        background: color-mix(in oklab, var(--surface), white 12%);
    }

    .note-list button strong {
        font-size: 0.95rem;
    }

    .note-list button span {
        font-size: 0.8rem;
        color: var(--ink-soft);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .note-list button small {
        font-size: 0.72rem;
        color: var(--ink-muted);
    }

    .note-list button.selected {
        border-color: color-mix(in oklab, var(--accent), transparent 30%);
        background: color-mix(in oklab, var(--accent), transparent 86%);
    }

    .editor-form {
        display: grid;
        gap: 0.8rem;
        height: 100%;
    }

    .editor-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.8rem;
    }

    .actions {
        display: flex;
        gap: 0.5rem;
    }

    .empty {
        display: grid;
        place-content: center;
        height: 100%;
        min-height: 320px;
        text-align: center;
        color: var(--ink-soft);
    }

    label {
        display: grid;
        gap: 0.35rem;
        font-size: 0.85rem;
        color: var(--ink-soft);
    }

    input,
    textarea,
    button {
        font: inherit;
    }

    input,
    textarea {
        border-radius: 0.7rem;
        border: 1px solid color-mix(in oklab, var(--surface-strong), transparent 65%);
        background: color-mix(in oklab, var(--surface), white 10%);
        color: var(--ink);
        padding: 0.55rem 0.65rem;
    }

    textarea {
        resize: vertical;
        min-height: 110px;
    }

    button {
        cursor: pointer;
        border-radius: 0.7rem;
        padding: 0.5rem 0.85rem;
        border: 1px solid transparent;
        background: color-mix(in oklab, var(--accent), black 8%);
        color: white;
        transition: transform 120ms ease, filter 120ms ease;
    }

    button:hover:enabled {
        transform: translateY(-1px);
        filter: brightness(1.03);
    }

    button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .quiet {
        background: transparent;
        color: var(--ink-soft);
        border-color: color-mix(in oklab, var(--surface-strong), transparent 55%);
    }

    .danger {
        background: color-mix(in oklab, #de5f5f, black 8%);
    }

    h2 {
        margin: 0;
        font-size: 1rem;
        font-family: var(--font-title), serif;
    }

    .hint {
        margin: 0;
        font-size: 0.8rem;
        color: var(--ink-muted);
    }

    @media (max-width: 920px) {
        .workspace {
            grid-template-columns: 1fr;
        }

        .note-list {
            max-height: none;
        }

        .editor-head {
            flex-direction: column;
            align-items: start;
        }
    }
</style>
