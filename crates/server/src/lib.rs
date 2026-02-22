use anyhow::Context;
use axum::{Extension, Router, http::StatusCode, routing::get};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

pub async fn build_app(database_url: &str) -> anyhow::Result<Router> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
        .context("failed to connect to postgres")?;

    let api_router = api_router(pool.clone()).await?;

    let app = Router::new()
        .route("/healthcheck", get(healthcheck))
        .nest("/api", api_router)
        .layer(TraceLayer::new_for_http())
        .layer(Extension(pool));

    Ok(app)
}

pub fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn"));

    let _ignored = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

async fn healthcheck(Extension(pool): Extension<PgPool>) -> StatusCode {
    match sqlx::query_scalar!("SELECT 1").fetch_one(&pool).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[cfg_attr(not(feature = "notes"), allow(unused_variables))]
async fn api_router(pool: PgPool) -> anyhow::Result<Router> {
    let api_router = Router::new();

    #[cfg(feature = "notes")]
    let api_router = {
        notes::run_migrations(&pool)
            .await
            .context("failed to run notes migrations")?;
        api_router.nest("/notes", notes::create_handlers(pool.clone()))
    };

    Ok(api_router)
}
