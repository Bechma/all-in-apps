CREATE TABLE IF NOT EXISTS chats (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    integration TEXT NULL CHECK (integration IN ('openai', 'anthropic', 'gemini', 'ollama')),
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    CHECK (
        (role = 'user' AND integration IS NULL)
        OR (role = 'assistant' AND integration IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id_created_at
    ON chat_messages (chat_id, created_at, id);
