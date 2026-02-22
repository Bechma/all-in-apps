// Source schema: crates/apps/notes/proto/notes.proto
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

export interface Note {
    id: number;
    title: string;
    body: string;
    created_at_unix_ms: number;
    updated_at_unix_ms: number;
    version: number;
}

export interface CreateNoteRequest {
    title: string;
    body: string;
}

export interface CreateNoteResponse {
    note?: Note;
}

export interface GetNoteResponse {
    note?: Note;
}

export interface ListNotesResponse {
    notes: Note[];
}

export interface UpdateNoteRequest {
    title?: string;
    body?: string;
}

export interface UpdateNoteResponse {
    note?: Note;
}

export interface DeleteNoteResponse {
    id: number;
}

export interface NoteDelta {
    id: number;
    title?: string;
    body?: string;
    updated_at_unix_ms: number;
    version: number;
}

export interface NoteDeleted {
    id: number;
}

export type NoteEvent =
    | { event: { kind: 'created'; note: Note } }
    | { event: { kind: 'updated'; delta: NoteDelta } }
    | { event: { kind: 'deleted'; deleted: NoteDeleted } }
    | { event: undefined };

class Writer {
    private bytes: number[] = [];

    writeTag(fieldNumber: number, wireType: number): void {
        this.writeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
    }

    writeVarint(value: bigint): void {
        let current = value;
        while (current >= 0x80n) {
            this.bytes.push(Number((current & 0x7fn) | 0x80n));
            current >>= 7n;
        }
        this.bytes.push(Number(current));
    }

    writeInt64(fieldNumber: number, value: number): void {
        this.writeTag(fieldNumber, WIRE_VARINT);
        this.writeVarint(numberToVarint(value));
    }

    writeString(fieldNumber: number, value: string): void {
        this.writeTag(fieldNumber, WIRE_LENGTH_DELIMITED);
        const encoded = textEncoder.encode(value);
        this.writeVarint(BigInt(encoded.length));
        for (const byte of encoded) {
            this.bytes.push(byte);
        }
    }

    writeMessage(fieldNumber: number, payload: Uint8Array): void {
        this.writeTag(fieldNumber, WIRE_LENGTH_DELIMITED);
        this.writeVarint(BigInt(payload.length));
        for (const byte of payload) {
            this.bytes.push(byte);
        }
    }

    finish(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

class Reader {
    private offset = 0;

    constructor(private readonly payload: Uint8Array) {
    }

    eof(): boolean {
        return this.offset >= this.payload.length;
    }

    readTag(): { fieldNumber: number; wireType: number } {
        const raw = Number(this.readVarint());
        return {
            fieldNumber: raw >>> 3,
            wireType: raw & 0b111
        };
    }

    readVarint(): bigint {
        let shift = 0n;
        let value = 0n;
        while (true) {
            if (this.offset >= this.payload.length) {
                throw new Error('unexpected end of protobuf payload');
            }
            const byte = this.payload[this.offset++];
            value |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return value;
            }
            shift += 7n;
            if (shift > 63n) {
                throw new Error('protobuf varint is too large');
            }
        }
    }

    readInt64(): number {
        const value = this.readVarint();
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`protobuf int64 exceeds Number.MAX_SAFE_INTEGER: ${value.toString()}`);
        }
        return Number(value);
    }

    readString(): string {
        const bytes = this.readBytes();
        return textDecoder.decode(bytes);
    }

    readBytes(): Uint8Array {
        const length = Number(this.readVarint());
        const end = this.offset + length;
        if (end > this.payload.length) {
            throw new Error('protobuf length-delimited field exceeds payload bounds');
        }
        const bytes = this.payload.subarray(this.offset, end);
        this.offset = end;
        return bytes;
    }

    skipField(wireType: number): void {
        switch (wireType) {
            case WIRE_VARINT: {
                void this.readVarint();
                return;
            }
            case WIRE_LENGTH_DELIMITED: {
                const length = Number(this.readVarint());
                const end = this.offset + length;
                if (end > this.payload.length) {
                    throw new Error('cannot skip field beyond payload bounds');
                }
                this.offset = end;
                return;
            }
            default:
                throw new Error(`unsupported protobuf wire type: ${wireType}`);
        }
    }
}

function numberToVarint(value: number): bigint {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`protobuf int64 must be a finite non-negative number, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
        throw new Error(`protobuf int64 must be a safe integer, got ${value}`);
    }
    return BigInt(value);
}

function decodeMessage<T>(
    bytes: Uint8Array,
    decode: (reader: Reader) => T
): T {
    return decode(new Reader(bytes));
}

export function encodeNote(message: Note): Uint8Array {
    const writer = new Writer();
    writer.writeInt64(1, message.id);
    writer.writeString(2, message.title);
    writer.writeString(3, message.body);
    writer.writeInt64(4, message.created_at_unix_ms);
    writer.writeInt64(5, message.updated_at_unix_ms);
    writer.writeInt64(6, message.version);
    return writer.finish();
}

export function decodeNote(bytes: Uint8Array): Note {
    return decodeMessage(bytes, (reader) => {
        const message: Note = {
            id: 0,
            title: '',
            body: '',
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            version: 0
        };

        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.id = reader.readInt64();
                    break;
                case 2:
                    message.title = reader.readString();
                    break;
                case 3:
                    message.body = reader.readString();
                    break;
                case 4:
                    message.created_at_unix_ms = reader.readInt64();
                    break;
                case 5:
                    message.updated_at_unix_ms = reader.readInt64();
                    break;
                case 6:
                    message.version = reader.readInt64();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }

        return message;
    });
}

export function encodeCreateNoteRequest(message: CreateNoteRequest): Uint8Array {
    const writer = new Writer();
    writer.writeString(1, message.title);
    writer.writeString(2, message.body);
    return writer.finish();
}

export function decodeCreateNoteRequest(bytes: Uint8Array): CreateNoteRequest {
    return decodeMessage(bytes, (reader) => {
        const message: CreateNoteRequest = {title: '', body: ''};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.title = reader.readString();
                    break;
                case 2:
                    message.body = reader.readString();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeCreateNoteResponse(message: CreateNoteResponse): Uint8Array {
    const writer = new Writer();
    if (message.note !== undefined) {
        writer.writeMessage(1, encodeNote(message.note));
    }
    return writer.finish();
}

export function decodeCreateNoteResponse(bytes: Uint8Array): CreateNoteResponse {
    return decodeMessage(bytes, (reader) => {
        const message: CreateNoteResponse = {};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.note = decodeNote(reader.readBytes());
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeGetNoteResponse(message: GetNoteResponse): Uint8Array {
    const writer = new Writer();
    if (message.note !== undefined) {
        writer.writeMessage(1, encodeNote(message.note));
    }
    return writer.finish();
}

export function decodeGetNoteResponse(bytes: Uint8Array): GetNoteResponse {
    return decodeMessage(bytes, (reader) => {
        const message: GetNoteResponse = {};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.note = decodeNote(reader.readBytes());
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeListNotesResponse(message: ListNotesResponse): Uint8Array {
    const writer = new Writer();
    for (const note of message.notes) {
        writer.writeMessage(1, encodeNote(note));
    }
    return writer.finish();
}

export function decodeListNotesResponse(bytes: Uint8Array): ListNotesResponse {
    return decodeMessage(bytes, (reader) => {
        const message: ListNotesResponse = {notes: []};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.notes.push(decodeNote(reader.readBytes()));
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeUpdateNoteRequest(message: UpdateNoteRequest): Uint8Array {
    const writer = new Writer();
    if (message.title !== undefined) {
        writer.writeString(1, message.title);
    }
    if (message.body !== undefined) {
        writer.writeString(2, message.body);
    }
    return writer.finish();
}

export function decodeUpdateNoteRequest(bytes: Uint8Array): UpdateNoteRequest {
    return decodeMessage(bytes, (reader) => {
        const message: UpdateNoteRequest = {};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.title = reader.readString();
                    break;
                case 2:
                    message.body = reader.readString();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeUpdateNoteResponse(message: UpdateNoteResponse): Uint8Array {
    const writer = new Writer();
    if (message.note !== undefined) {
        writer.writeMessage(1, encodeNote(message.note));
    }
    return writer.finish();
}

export function decodeUpdateNoteResponse(bytes: Uint8Array): UpdateNoteResponse {
    return decodeMessage(bytes, (reader) => {
        const message: UpdateNoteResponse = {};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.note = decodeNote(reader.readBytes());
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeDeleteNoteResponse(message: DeleteNoteResponse): Uint8Array {
    const writer = new Writer();
    writer.writeInt64(1, message.id);
    return writer.finish();
}

export function decodeDeleteNoteResponse(bytes: Uint8Array): DeleteNoteResponse {
    return decodeMessage(bytes, (reader) => {
        const message: DeleteNoteResponse = {id: 0};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.id = reader.readInt64();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeNoteDelta(message: NoteDelta): Uint8Array {
    const writer = new Writer();
    writer.writeInt64(1, message.id);
    if (message.title !== undefined) {
        writer.writeString(2, message.title);
    }
    if (message.body !== undefined) {
        writer.writeString(3, message.body);
    }
    writer.writeInt64(4, message.updated_at_unix_ms);
    writer.writeInt64(5, message.version);
    return writer.finish();
}

export function decodeNoteDelta(bytes: Uint8Array): NoteDelta {
    return decodeMessage(bytes, (reader) => {
        const message: NoteDelta = {
            id: 0,
            updated_at_unix_ms: 0,
            version: 0
        };
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.id = reader.readInt64();
                    break;
                case 2:
                    message.title = reader.readString();
                    break;
                case 3:
                    message.body = reader.readString();
                    break;
                case 4:
                    message.updated_at_unix_ms = reader.readInt64();
                    break;
                case 5:
                    message.version = reader.readInt64();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeNoteDeleted(message: NoteDeleted): Uint8Array {
    const writer = new Writer();
    writer.writeInt64(1, message.id);
    return writer.finish();
}

export function decodeNoteDeleted(bytes: Uint8Array): NoteDeleted {
    return decodeMessage(bytes, (reader) => {
        const message: NoteDeleted = {id: 0};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message.id = reader.readInt64();
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}

export function encodeNoteEvent(message: NoteEvent): Uint8Array {
    const writer = new Writer();
    if (message.event?.kind === 'created') {
        writer.writeMessage(1, encodeNote(message.event.note));
    }
    if (message.event?.kind === 'updated') {
        writer.writeMessage(2, encodeNoteDelta(message.event.delta));
    }
    if (message.event?.kind === 'deleted') {
        writer.writeMessage(3, encodeNoteDeleted(message.event.deleted));
    }
    return writer.finish();
}

export function decodeNoteEvent(bytes: Uint8Array): NoteEvent {
    return decodeMessage(bytes, (reader) => {
        let message: NoteEvent = {event: undefined};
        while (!reader.eof()) {
            const {fieldNumber, wireType} = reader.readTag();
            switch (fieldNumber) {
                case 1:
                    message = {event: {kind: 'created', note: decodeNote(reader.readBytes())}};
                    break;
                case 2:
                    message = {event: {kind: 'updated', delta: decodeNoteDelta(reader.readBytes())}};
                    break;
                case 3:
                    message = {
                        event: {
                            kind: 'deleted',
                            deleted: decodeNoteDeleted(reader.readBytes())
                        }
                    };
                    break;
                default:
                    reader.skipField(wireType);
                    break;
            }
        }
        return message;
    });
}
