use sqlx::PgPool;

mod errors;
mod handlers;
mod protobuf;
mod state;

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/ai_chat.v1.rs"));
}

pub use errors::AiChatError;
pub use handlers::create_handlers;
pub use protobuf::Protobuf;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn run_migrations(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}
