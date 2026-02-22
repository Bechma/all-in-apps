import {createMutation, createQuery, type QueryClient, useQueryClient} from '@tanstack/svelte-query';
import {
    CreateNoteRequestSchema,
    CreateNoteResponseSchema,
    DeleteNoteResponseSchema,
    ListNotesResponseSchema,
    type Note,
    type NoteDelta,
    type NoteEvent,
    NoteEventSchema,
    UpdateNoteRequestSchema,
    UpdateNoteResponseSchema
} from '$lib/protobuf/gen/notes_pb';
import {create, fromBinary, type MessageInitShape, toBinary} from '@bufbuild/protobuf';

const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

type WebSocketFactory = (url: string) => WebSocket;

type CreateNoteInput = MessageInitShape<typeof CreateNoteRequestSchema>;
type UpdateNoteInput = MessageInitShape<typeof UpdateNoteRequestSchema>;

export interface NotesApiOptions {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    webSocketFactory?: WebSocketFactory;
}

export interface SubscribeOptions {
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (error: unknown) => void;
}

interface UpdateNoteMutationVariables {
    noteId: bigint;
    request: UpdateNoteInput;
}

function normalizedBaseUrl(baseUrl?: string): string {
    return baseUrl?.replace(/\/+$/, '') ?? '';
}

function notesQueryKey(baseUrl?: string): readonly ['notes', string] {
    return ['notes', normalizedBaseUrl(baseUrl)] as const;
}

function createNotesTransport(options: NotesApiOptions = {}) {
    const baseUrl = normalizedBaseUrl(options.baseUrl);
    const fetchImpl = options.fetchImpl ?? fetch;

    const request = async <TResponse>({
                                          method,
                                          path,
                                          body,
                                          decode
                                      }: {
        method: string;
        path: string;
        body?: Uint8Array;
        decode: (payload: Uint8Array) => TResponse;
    }): Promise<TResponse> => {
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers:
                body === undefined
                    ? undefined
                    : {
                        'content-type': PROTOBUF_CONTENT_TYPE
                    },
            body: body === undefined ? undefined : toRequestBody(body)
        });

        if (!response.ok) {
            const maybeText = await response.text().catch(() => '');
            const suffix = maybeText ? `: ${maybeText}` : '';
            throw new Error(`${method} ${path} failed with ${response.status}${suffix}`);
        }

        return decode(new Uint8Array(await response.arrayBuffer()));
    };

    return {
        async listNotes(): Promise<Note[]> {
            const response = await request({
                method: 'GET',
                path: '/api/notes',
                decode: (payload) => fromBinary(ListNotesResponseSchema, payload)
            });
            return sortNotes(response.notes);
        },
        async createNote(requestBody: CreateNoteInput): Promise<Note> {
            const response = await request({
                method: 'POST',
                path: '/api/notes',
                body: toBinary(CreateNoteRequestSchema, create(CreateNoteRequestSchema, requestBody)),
                decode: (payload) => fromBinary(CreateNoteResponseSchema, payload)
            });
            if (response.note === undefined) {
                throw new Error('backend returned an empty create response');
            }
            return response.note;
        },
        async updateNote(noteId: bigint, requestBody: UpdateNoteInput): Promise<Note> {
            const response = await request({
                method: 'PATCH',
                path: `/api/notes/${noteId}`,
                body: toBinary(UpdateNoteRequestSchema, create(UpdateNoteRequestSchema, requestBody)),
                decode: (payload) => fromBinary(UpdateNoteResponseSchema, payload)
            });
            if (response.note === undefined) {
                throw new Error('backend returned an empty update response');
            }
            return response.note;
        },
        async deleteNote(noteId: bigint): Promise<bigint> {
            const response = await request({
                method: 'DELETE',
                path: `/api/notes/${noteId}`,
                decode: (payload) => fromBinary(DeleteNoteResponseSchema, payload)
            });
            return response.id;
        }
    };
}

export function createNotesQuery(options: NotesApiOptions = {}) {
    const transport = createNotesTransport(options);
    return createQuery(() => ({
        queryKey: notesQueryKey(options.baseUrl),
        queryFn: () => transport.listNotes()
    }));
}

export function createCreateNoteMutation(options: NotesApiOptions = {}) {
    const transport = createNotesTransport(options);
    const queryClient = useQueryClient();
    const queryKey = notesQueryKey(options.baseUrl);

    return createMutation(() => ({
        mutationFn: (requestBody: CreateNoteInput) => transport.createNote(requestBody),
        onSuccess: (note) => {
            queryClient.setQueryData<Note[]>(queryKey, (current) => upsertNote(current ?? [], note));
        }
    }));
}

export function createUpdateNoteMutation(options: NotesApiOptions = {}) {
    const transport = createNotesTransport(options);
    const queryClient = useQueryClient();
    const queryKey = notesQueryKey(options.baseUrl);

    return createMutation(() => ({
        mutationFn: ({noteId, request}: UpdateNoteMutationVariables) => transport.updateNote(noteId, request),
        onSuccess: (note) => {
            queryClient.setQueryData<Note[]>(queryKey, (current) => upsertNote(current ?? [], note));
        }
    }));
}

export function createDeleteNoteMutation(options: NotesApiOptions = {}) {
    const transport = createNotesTransport(options);
    const queryClient = useQueryClient();
    const queryKey = notesQueryKey(options.baseUrl);

    return createMutation(() => ({
        mutationFn: (noteId: bigint) => transport.deleteNote(noteId),
        onSuccess: (noteId) => {
            queryClient.setQueryData<Note[]>(queryKey, (current) => removeNote(current ?? [], noteId));
        }
    }));
}

export function applyNoteEventToCache(
    queryClient: QueryClient,
    event: NoteEvent,
    options: NotesApiOptions = {}
): void {
    const queryKey = notesQueryKey(options.baseUrl);

    switch (event.event.case) {
        case 'created': {
            const created = event.event.value as Note | undefined;
            if (created !== undefined) {
                queryClient.setQueryData<Note[]>(queryKey, (current) => upsertNote(current ?? [], created));
            }
            break;
        }
        case 'updated': {
            const updated = event.event.value as NoteDelta | undefined;
            if (updated !== undefined) {
                queryClient.setQueryData<Note[]>(queryKey, (current) => applyDelta(current ?? [], updated));
            }
            break;
        }
        case 'deleted': {
            const deleted = event.event.value as { id: bigint } | undefined;
            if (deleted !== undefined) {
                queryClient.setQueryData<Note[]>(queryKey, (current) => removeNote(current ?? [], deleted.id));
            }
            break;
        }
        default:
            break;
    }
}

export function subscribeNoteEvents(
    onEvent: (event: NoteEvent) => void,
    options: NotesApiOptions = {},
    subscribeOptions: SubscribeOptions = {}
): () => void {
    const createSocket = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = createSocket(buildWebSocketUrl('/api/notes/events', options.baseUrl));
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
        subscribeOptions.onOpen?.();
    };

    socket.onclose = () => {
        subscribeOptions.onClose?.();
    };

    socket.onerror = (error) => {
        subscribeOptions.onError?.(error);
    };

    socket.onmessage = (event) => {
        void decodeSocketFrame(event.data)
            .then((payload) => {
                onEvent(fromBinary(NoteEventSchema, payload));
            })
            .catch((error) => {
                subscribeOptions.onError?.(error);
            });
    };

    return () => {
        socket.close();
    };
}

function sortNotes(items: Note[]): Note[] {
    return [...items].sort((a, b) => {
        if (a.updatedAtUnixMs !== b.updatedAtUnixMs) {
            return a.updatedAtUnixMs < b.updatedAtUnixMs ? 1 : -1;
        }
        return a.id < b.id ? 1 : -1;
    });
}

function upsertNote(notes: Note[], note: Note): Note[] {
    const index = notes.findIndex((candidate) => candidate.id === note.id);
    if (index === -1) {
        return sortNotes([...notes, note]);
    }

    const next = [...notes];
    next[index] = note;
    return sortNotes(next);
}

function applyDelta(notes: Note[], delta: NoteDelta): Note[] {
    const existing = notes.find((candidate) => candidate.id === delta.id);
    if (existing === undefined) {
        return notes;
    }

    return upsertNote(notes, {
        ...existing,
        title: delta.title ?? existing.title,
        body: delta.body ?? existing.body,
        updatedAtUnixMs: delta.updatedAtUnixMs,
        version: delta.version
    });
}

function removeNote(notes: Note[], noteId: bigint): Note[] {
    return notes.filter((note) => note.id !== noteId);
}

function buildWebSocketUrl(path: string, baseUrl?: string): string {
    const normalizedUrl = normalizedBaseUrl(baseUrl);
    if (normalizedUrl.length > 0) {
        try {
            const url = new URL(path, normalizedUrl.endsWith('/') ? normalizedUrl : `${normalizedUrl}/`);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            return url.toString();
        } catch {
            // Fall through to browser location resolution.
        }
    }

    if (typeof window !== 'undefined') {
        const url = new URL(path, window.location.origin);
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
    }

    throw new Error('cannot build websocket URL without an absolute baseUrl outside the browser');
}

function toRequestBody(payload: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    return copy.buffer;
}

async function decodeSocketFrame(data: Blob | ArrayBuffer | string | Uint8Array): Promise<Uint8Array> {
    if (typeof data === 'string') {
        throw new Error('expected protobuf binary websocket frame but received text');
    }
    if (data instanceof Blob) {
        return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return data;
}
