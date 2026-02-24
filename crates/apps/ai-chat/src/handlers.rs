use std::collections::HashSet;

use axum::{
    Router,
    extract::{Path, State},
    routing::post,
};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{
    AiChatError, Protobuf, pb,
    state::{
        AiChatState, ChatMessageRow, ChatRow, build_state, integration_to_db, now_unix_millis,
    },
};

pub fn create_handlers(pool: PgPool) -> Router {
    let state = build_state(pool);

    Router::new()
        .route("/", post(create_chat).get(list_chats))
        .route("/{chat_id}/interact", post(interact_chat))
        .with_state(state)
}

async fn create_chat(
    State(state): State<AiChatState>,
    Protobuf(payload): Protobuf<pb::CreateChatRequest>,
) -> Result<Protobuf<pb::CreateChatResponse>, AiChatError> {
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AiChatError::Validation("title cannot be empty"));
    }

    let now = now_unix_millis();
    let row = sqlx::query_as!(
        ChatRow,
        r#"
        INSERT INTO chats (title, created_at, updated_at)
        VALUES ($1, $2, $2)
        RETURNING id, title, created_at, updated_at
        "#,
        title,
        now
    )
    .fetch_one(&state.pool)
    .await?;

    Ok(Protobuf(pb::CreateChatResponse {
        chat: Some(pb::Chat::from(row)),
    }))
}

async fn list_chats(
    State(state): State<AiChatState>,
) -> Result<Protobuf<pb::ListChatsResponse>, AiChatError> {
    let rows = sqlx::query_as!(
        ChatRow,
        r#"
        SELECT id, title, created_at, updated_at
        FROM chats
        ORDER BY id
        "#,
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Protobuf(pb::ListChatsResponse {
        chats: rows.into_iter().map(pb::Chat::from).collect(),
    }))
}

async fn interact_chat(
    Path(chat_id): Path<i64>,
    State(state): State<AiChatState>,
    Protobuf(payload): Protobuf<pb::InteractChatRequest>,
) -> Result<Protobuf<pb::InteractChatResponse>, AiChatError> {
    let prompt = payload.prompt.trim();
    if prompt.is_empty() {
        return Err(AiChatError::Validation("prompt cannot be empty"));
    }

    let integrations = parse_integrations(payload.integrations)?;

    let mut tx = state.pool.begin().await?;
    let mut chat = fetch_chat(chat_id, &mut tx).await?;
    let now = now_unix_millis();

    let prompt_message = sqlx::query_as!(
        ChatMessageRow,
        r#"
        INSERT INTO chat_messages (chat_id, role, integration, content, created_at)
        VALUES ($1, 'user', NULL, $2, $3)
        RETURNING id, chat_id, role, integration, content, created_at
        "#,
        chat_id,
        prompt,
        now
    )
    .fetch_one(&mut *tx)
    .await?;

    let mut responses = Vec::with_capacity(integrations.len());
    for integration in integrations {
        let content = synthesize_response(integration, prompt);
        let row = sqlx::query_as!(
            ChatMessageRow,
            r#"
            INSERT INTO chat_messages (chat_id, role, integration, content, created_at)
            VALUES ($1, 'assistant', $2, $3, $4)
            RETURNING id, chat_id, role, integration, content, created_at
            "#,
            chat_id,
            integration_to_db(integration),
            content,
            now
        )
        .fetch_one(&mut *tx)
        .await?;
        responses.push(pb::ChatMessage::from(row));
    }

    chat.updated_at = now;
    sqlx::query!(
        r#"
        UPDATE chats
        SET updated_at = $1
        WHERE id = $2
        "#,
        now,
        chat_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Protobuf(pb::InteractChatResponse {
        chat: Some(pb::Chat::from(chat)),
        prompt_message: Some(pb::ChatMessage::from(prompt_message)),
        responses,
    }))
}

fn parse_integrations(values: Vec<i32>) -> Result<Vec<pb::LlmIntegration>, AiChatError> {
    if values.is_empty() {
        return Err(AiChatError::Validation(
            "at least one integration must be provided",
        ));
    }
    if values.len() > 4 {
        return Err(AiChatError::Validation(
            "a single prompt supports at most 4 integrations",
        ));
    }

    let mut integrations = Vec::with_capacity(values.len());
    let mut dedupe = HashSet::with_capacity(values.len());
    for value in values {
        let integration = pb::LlmIntegration::try_from(value)
            .map_err(|_| AiChatError::Validation("invalid integration value"))?;
        if integration == pb::LlmIntegration::Unspecified {
            return Err(AiChatError::Validation("integration cannot be unspecified"));
        }

        if !dedupe.insert(integration as i32) {
            return Err(AiChatError::Validation(
                "integrations must not contain duplicates",
            ));
        }

        integrations.push(integration);
    }

    Ok(integrations)
}

async fn fetch_chat(
    chat_id: i64,
    tx: &mut Transaction<'_, Postgres>,
) -> Result<ChatRow, AiChatError> {
    let chat = sqlx::query_as!(
        ChatRow,
        r#"
        SELECT id, title, created_at, updated_at
        FROM chats
        WHERE id = $1
        "#,
        chat_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    chat.ok_or(AiChatError::NotFound(chat_id))
}

fn synthesize_response(integration: pb::LlmIntegration, prompt: &str) -> String {
    match integration {
        pb::LlmIntegration::Openai => {
            format!("OpenAI preview response: processed prompt `{prompt}`")
        }
        pb::LlmIntegration::Anthropic => {
            format!("Anthropic preview response: processed prompt `{prompt}`")
        }
        pb::LlmIntegration::Gemini => {
            format!("Gemini preview response: processed prompt `{prompt}`")
        }
        pb::LlmIntegration::Ollama => {
            format!("Ollama preview response: processed prompt `{prompt}`")
        }
        pb::LlmIntegration::Unspecified => "Integration not specified".to_owned(),
    }
}
