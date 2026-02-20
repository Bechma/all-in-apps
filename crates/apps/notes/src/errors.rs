use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NotesError {
    #[error("request body must be protocol buffers bytes")]
    InvalidBody,
    #[error("invalid protocol buffers payload: {0}")]
    InvalidProtobuf(prost::DecodeError),
    #[error("note {0} was not found")]
    NotFound(i64),
    #[error("{0}")]
    Validation(&'static str),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for NotesError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::InvalidBody | Self::InvalidProtobuf(_) | Self::Validation(_) => {
                (StatusCode::BAD_REQUEST, self.to_string())
            }
            Self::NotFound(_) => (StatusCode::NOT_FOUND, self.to_string()),
            Self::Database(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal server error".to_owned(),
            ),
        };

        (status, message).into_response()
    }
}
