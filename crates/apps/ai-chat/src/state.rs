use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::PgPool;

use crate::pb;

#[derive(Clone)]
pub(crate) struct AiChatState {
    pub(crate) pool: PgPool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ChatRow {
    pub(crate) id: i64,
    pub(crate) title: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ChatMessageRow {
    pub(crate) id: i64,
    pub(crate) chat_id: i64,
    pub(crate) role: String,
    pub(crate) integration: Option<String>,
    pub(crate) content: String,
    pub(crate) created_at: i64,
}

impl From<ChatRow> for pb::Chat {
    fn from(value: ChatRow) -> Self {
        Self {
            id: value.id,
            title: value.title,
            created_at_unix_ms: value.created_at,
            updated_at_unix_ms: value.updated_at,
        }
    }
}

impl From<ChatMessageRow> for pb::ChatMessage {
    fn from(value: ChatMessageRow) -> Self {
        Self {
            id: value.id,
            chat_id: value.chat_id,
            role: message_role_to_proto(value.role.as_str()) as i32,
            integration: integration_to_proto(value.integration.as_deref()) as i32,
            content: value.content,
            created_at_unix_ms: value.created_at,
        }
    }
}

pub(crate) fn build_state(pool: PgPool) -> AiChatState {
    AiChatState { pool }
}

pub(crate) fn now_unix_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub(crate) fn integration_to_db(integration: pb::LlmIntegration) -> Option<&'static str> {
    match integration {
        pb::LlmIntegration::Unspecified => None,
        pb::LlmIntegration::Openai => Some("openai"),
        pb::LlmIntegration::Anthropic => Some("anthropic"),
        pb::LlmIntegration::Gemini => Some("gemini"),
        pb::LlmIntegration::Ollama => Some("ollama"),
    }
}

fn integration_to_proto(integration: Option<&str>) -> pb::LlmIntegration {
    match integration {
        Some("openai") => pb::LlmIntegration::Openai,
        Some("anthropic") => pb::LlmIntegration::Anthropic,
        Some("gemini") => pb::LlmIntegration::Gemini,
        Some("ollama") => pb::LlmIntegration::Ollama,
        _ => pb::LlmIntegration::Unspecified,
    }
}

fn message_role_to_proto(role: &str) -> pb::ChatMessageRole {
    match role {
        "user" => pb::ChatMessageRole::User,
        "assistant" => pb::ChatMessageRole::Assistant,
        _ => pb::ChatMessageRole::Unspecified,
    }
}
