import {
	type CreateNoteRequest,
	type CreateNoteResponse,
	decodeCreateNoteResponse,
	decodeDeleteNoteResponse,
	decodeGetNoteResponse,
	decodeListNotesResponse,
	decodeNoteEvent,
	decodeUpdateNoteResponse,
	type DeleteNoteResponse,
	encodeCreateNoteRequest,
	encodeUpdateNoteRequest,
	type GetNoteResponse,
	type ListNotesResponse,
	type NoteEvent,
	type UpdateNoteRequest,
	type UpdateNoteResponse
} from '$lib/protobuf/notes';

const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

type WebSocketFactory = (url: string) => WebSocket;

export interface NotesApiClientOptions {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    webSocketFactory?: WebSocketFactory;
}

interface SubscribeOptions {
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (error: unknown) => void;
}

export interface NotesApiClient {
    createNote(request: CreateNoteRequest): Promise<CreateNoteResponse>;

    listNotes(): Promise<ListNotesResponse>;

    getNote(noteId: number): Promise<GetNoteResponse>;

    updateNote(noteId: number, request: UpdateNoteRequest): Promise<UpdateNoteResponse>;

    deleteNote(noteId: number): Promise<DeleteNoteResponse>;

    subscribeNoteEvents(onEvent: (event: NoteEvent) => void, options?: SubscribeOptions): () => void;
}

export function createNotesApiClient(options: NotesApiClientOptions = {}): NotesApiClient {
    const baseUrl = options.baseUrl?.replace(/\/+$/, '') ?? '';
    const fetchImpl = options.fetchImpl ?? fetch;

    const buildUrl = (path: string): string => `${baseUrl}${path}`;
    const buildWebSocketUrl = (path: string): string => {
        const fromBase = (() => {
            if (!baseUrl) {
                return undefined;
            }

            try {
                const url = new URL(path, ensureTrailingSlash(baseUrl));
                url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                return url.toString();
            } catch {
                return undefined;
            }
        })();

        if (fromBase !== undefined) {
            return fromBase;
        }

        if (typeof window !== 'undefined') {
            const url = new URL(path, window.location.origin);
            url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            return url.toString();
        }

        throw new Error('cannot build websocket URL without an absolute baseUrl outside the browser');
    };

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
        const response = await fetchImpl(buildUrl(path), {
            method,
            headers:
                body !== undefined
                    ? {
                        'content-type': PROTOBUF_CONTENT_TYPE
                    }
                    : undefined,
            body: body === undefined ? undefined : toRequestBody(body)
        });

        if (!response.ok) {
            const maybeText = await response.text().catch(() => '');
            const suffix = maybeText ? `: ${maybeText}` : '';
            throw new Error(`${method} ${path} failed with ${response.status}${suffix}`);
        }

        const payload = new Uint8Array(await response.arrayBuffer());
        return decode(payload);
    };

    return {
        createNote(requestBody) {
            return request({
                method: 'POST',
                path: '/api/notes',
                body: encodeCreateNoteRequest(requestBody),
                decode: decodeCreateNoteResponse
            });
        },
        listNotes() {
            return request({
                method: 'GET',
                path: '/api/notes',
                decode: decodeListNotesResponse
            });
        },
        getNote(noteId) {
            return request({
                method: 'GET',
                path: `/api/notes/${noteId}`,
                decode: decodeGetNoteResponse
            });
        },
        updateNote(noteId, requestBody) {
            return request({
                method: 'PATCH',
                path: `/api/notes/${noteId}`,
                body: encodeUpdateNoteRequest(requestBody),
                decode: decodeUpdateNoteResponse
            });
        },
        deleteNote(noteId) {
            return request({
                method: 'DELETE',
                path: `/api/notes/${noteId}`,
                decode: decodeDeleteNoteResponse
            });
        },
        subscribeNoteEvents(onEvent, subscribeOptions) {
            const createSocket = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
            const socket = createSocket(buildWebSocketUrl('/api/notes/events'));
            socket.binaryType = 'arraybuffer';

            socket.onopen = () => {
                subscribeOptions?.onOpen?.();
            };

            socket.onclose = () => {
                subscribeOptions?.onClose?.();
            };

            socket.onerror = (error) => {
                subscribeOptions?.onError?.(error);
            };

            socket.onmessage = (event) => {
                void decodeSocketFrame(event.data)
                    .then((payload) => {
                        onEvent(decodeNoteEvent(payload));
                    })
                    .catch((error) => {
                        subscribeOptions?.onError?.(error);
                    });
            };

            return () => {
                socket.close();
            };
        }
    };
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
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
