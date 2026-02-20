use axum::{
    extract::Request,
    http::{
        HeaderValue,
        header::{CONTENT_TYPE, HeaderName},
    },
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use prost::Message as ProstMessage;

use crate::NotesError;

const PROTOBUF_CONTENT_TYPE: &str = "application/x-protobuf";
const PROTOBUF_CONTENT_TYPE_HEADER: HeaderName = CONTENT_TYPE;

pub struct Protobuf<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for Protobuf<T>
where
    S: Send + Sync,
    Bytes: axum::extract::FromRequest<S>,
    T: ProstMessage + Default,
{
    type Rejection = NotesError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let body = Bytes::from_request(req, state)
            .await
            .map_err(|_| NotesError::InvalidBody)?;
        let value = T::decode(body).map_err(NotesError::InvalidProtobuf)?;
        Ok(Self(value))
    }
}

impl<T> IntoResponse for Protobuf<T>
where
    T: ProstMessage,
{
    fn into_response(self) -> Response {
        let mut response = self.0.encode_to_vec().into_response();
        response.headers_mut().insert(
            PROTOBUF_CONTENT_TYPE_HEADER,
            HeaderValue::from_static(PROTOBUF_CONTENT_TYPE),
        );
        response
    }
}
