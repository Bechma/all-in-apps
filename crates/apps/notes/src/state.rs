use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::PgPool;
use tokio::sync::broadcast;

use crate::pb;

#[derive(Clone)]
pub(crate) struct NotesState {
    pub(crate) pool: PgPool,
    pub(crate) events_tx: broadcast::Sender<pb::NoteEvent>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct NoteRow {
    pub(crate) id: i64,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) version: i64,
}

impl From<NoteRow> for pb::Note {
    fn from(value: NoteRow) -> Self {
        Self {
            id: value.id,
            title: value.title,
            body: value.body,
            created_at_unix_ms: value.created_at,
            updated_at_unix_ms: value.updated_at,
            version: value.version,
        }
    }
}

pub(crate) fn build_state(pool: PgPool) -> NotesState {
    let (events_tx, _) = broadcast::channel(512);
    NotesState { pool, events_tx }
}

pub(crate) fn emit_event(events_tx: &broadcast::Sender<pb::NoteEvent>, event: pb::NoteEvent) {
    if events_tx.send(event).is_err() {
        // No active realtime subscribers is expected and not a server error.
    }
}

pub(crate) fn now_unix_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}
