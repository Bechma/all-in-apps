use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    server::init_tracing();

    let database_url =
        std::env::var("DATABASE_URL").context("DATABASE_URL must be set for the server")?;
    let listen_addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_owned());

    let app = server::build_app(&database_url).await?;
    let listener = TcpListener::bind(&listen_addr).await?;

    info!("server listening on {listen_addr}");
    axum::serve(listener, app).await?;

    Ok(())
}
