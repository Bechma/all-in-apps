use axum::{
    Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::{get, post},
};
use bytes::Bytes;
use prost::Message as ProstMessage;
use sqlx::PgPool;
use tokio::sync::broadcast;
use tracing::warn;

use crate::{
    NotesError, Protobuf, pb,
    state::{NoteRow, NotesState, build_state, emit_event, now_unix_millis},
};

pub fn create_handlers(pool: PgPool) -> Router {
    let state = build_state(pool);

    Router::new()
        .route("/", post(create_note).get(list_notes))
        .route(
            "/{note_id}",
            get(get_note).patch(update_note).delete(delete_note),
        )
        .route("/events", get(subscribe_note_events))
        .with_state(state)
}

async fn create_note(
    State(state): State<NotesState>,
    Protobuf(payload): Protobuf<pb::CreateNoteRequest>,
) -> Result<Protobuf<pb::CreateNoteResponse>, NotesError> {
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(NotesError::Validation("title cannot be empty"));
    }

    let now = now_unix_millis();
    let row = sqlx::query_as::<_, NoteRow>(
        r"
        INSERT INTO notes (title, body, created_at, updated_at, version)
        VALUES ($1, $2, $3, $3, 1)
        RETURNING id, title, body, created_at, updated_at, version
        ",
    )
    .bind(title)
    .bind(payload.body)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    let note = pb::Note::from(row);
    emit_event(
        &state.events_tx,
        pb::NoteEvent {
            event: Some(pb::note_event::Event::Created(note.clone())),
        },
    );

    Ok(Protobuf(pb::CreateNoteResponse { note: Some(note) }))
}

async fn list_notes(
    State(state): State<NotesState>,
) -> Result<Protobuf<pb::ListNotesResponse>, NotesError> {
    let rows = sqlx::query_as::<_, NoteRow>(
        r"
        SELECT id, title, body, created_at, updated_at, version
        FROM notes
        ORDER BY id
        ",
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Protobuf(pb::ListNotesResponse {
        notes: rows.into_iter().map(pb::Note::from).collect(),
    }))
}

async fn get_note(
    Path(note_id): Path<i64>,
    State(state): State<NotesState>,
) -> Result<Protobuf<pb::GetNoteResponse>, NotesError> {
    let row = sqlx::query_as::<_, NoteRow>(
        r"
        SELECT id, title, body, created_at, updated_at, version
        FROM notes
        WHERE id = $1
        ",
    )
    .bind(note_id)
    .fetch_optional(&state.pool)
    .await?;

    let note = row.ok_or(NotesError::NotFound(note_id))?;
    Ok(Protobuf(pb::GetNoteResponse {
        note: Some(pb::Note::from(note)),
    }))
}

async fn update_note(
    Path(note_id): Path<i64>,
    State(state): State<NotesState>,
    Protobuf(payload): Protobuf<pb::UpdateNoteRequest>,
) -> Result<Protobuf<pb::UpdateNoteResponse>, NotesError> {
    if payload.title.is_none() && payload.body.is_none() {
        return Err(NotesError::Validation(
            "at least one field must be provided",
        ));
    }

    let mut row = sqlx::query_as::<_, NoteRow>(
        r"
        SELECT id, title, body, created_at, updated_at, version
        FROM notes
        WHERE id = $1
        ",
    )
    .bind(note_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(NotesError::NotFound(note_id))?;

    let mut delta = pb::NoteDelta {
        id: note_id,
        title: None,
        body: None,
        updated_at_unix_ms: row.updated_at,
        version: row.version,
    };
    let mut changed = false;

    if let Some(title) = payload.title {
        let title = title.trim().to_owned();
        if title.is_empty() {
            return Err(NotesError::Validation("title cannot be empty"));
        }
        if title != row.title {
            row.title.clone_from(&title);
            delta.title = Some(title);
            changed = true;
        }
    }

    if let Some(body) = payload.body
        && body != row.body
    {
        row.body.clone_from(&body);
        delta.body = Some(body);
        changed = true;
    }

    if changed {
        row.version += 1;
        row.updated_at = now_unix_millis();
        delta.version = row.version;
        delta.updated_at_unix_ms = row.updated_at;

        sqlx::query(
            r"
            UPDATE notes
            SET title = $1, body = $2, updated_at = $3, version = $4
            WHERE id = $5
            ",
        )
        .bind(&row.title)
        .bind(&row.body)
        .bind(row.updated_at)
        .bind(row.version)
        .bind(note_id)
        .execute(&state.pool)
        .await?;

        emit_event(
            &state.events_tx,
            pb::NoteEvent {
                event: Some(pb::note_event::Event::Updated(delta)),
            },
        );
    }

    Ok(Protobuf(pb::UpdateNoteResponse {
        note: Some(pb::Note::from(row)),
    }))
}

async fn delete_note(
    Path(note_id): Path<i64>,
    State(state): State<NotesState>,
) -> Result<Protobuf<pb::DeleteNoteResponse>, NotesError> {
    let result = sqlx::query("DELETE FROM notes WHERE id = $1")
        .bind(note_id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(NotesError::NotFound(note_id));
    }

    emit_event(
        &state.events_tx,
        pb::NoteEvent {
            event: Some(pb::note_event::Event::Deleted(pb::NoteDeleted {
                id: note_id,
            })),
        },
    );

    Ok(Protobuf(pb::DeleteNoteResponse { id: note_id }))
}

async fn subscribe_note_events(
    websocket: WebSocketUpgrade,
    State(state): State<NotesState>,
) -> impl IntoResponse {
    let events_rx = state.events_tx.subscribe();
    websocket.on_upgrade(move |socket| websocket_loop(socket, events_rx))
}

async fn websocket_loop(mut socket: WebSocket, mut events_rx: broadcast::Receiver<pb::NoteEvent>) {
    loop {
        match events_rx.recv().await {
            Ok(event) => {
                let payload = Bytes::from(event.encode_to_vec());
                if socket.send(Message::Binary(payload)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped_count)) => {
                warn!("websocket receiver lagged by {skipped_count} events");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}
