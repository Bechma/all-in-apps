use std::time::Duration;

use axum::Router;
use futures_util::StreamExt;
use notes::pb::{
    CreateNoteRequest, CreateNoteResponse, DeleteNoteResponse, GetNoteResponse, ListNotesResponse,
    NoteDelta, NoteEvent, UpdateNoteRequest, UpdateNoteResponse, note_event,
};
use prost::Message;
use reqwest::{Client, Method, StatusCode};
use sqlx::postgres::PgPoolOptions;
use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::runners::AsyncRunner;
use tokio::{net::TcpListener, task::JoinHandle, time::sleep};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::protocol::Message as WsMessage,
};

const PROTOBUF_CONTENT_TYPE: &str = "application/x-protobuf";

type WsConnection = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn notes_crud_and_realtime_delta_flow() {
    let postgres = Postgres::default()
        .start()
        .await
        .expect("failed to start postgres container");
    let port = postgres
        .get_host_port_ipv4(5432)
        .await
        .expect("postgres mapped port was not available");
    let database_url = format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("failed to connect to postgres");
    notes::run_migrations(&pool)
        .await
        .expect("failed to run notes migrations");

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind test listener");
    let socket_addr = listener
        .local_addr()
        .expect("failed to read local listener address");
    let app = Router::new().nest("/notes", notes::create_handlers(pool));

    let server_task = spawn_server(listener, app);
    wait_for_notes_endpoint(socket_addr.port()).await;

    let http_base = format!("http://127.0.0.1:{}", socket_addr.port());
    let ws_url = format!("ws://127.0.0.1:{}/notes/events", socket_addr.port());
    let client = Client::new();

    let (mut websocket, _) = connect_async(ws_url)
        .await
        .expect("failed to connect websocket");

    let created = request_protobuf::<_, CreateNoteResponse>(
        &client,
        Method::POST,
        &format!("{http_base}/notes"),
        &CreateNoteRequest {
            title: "draft".to_owned(),
            body: "hello body".to_owned(),
        },
    )
    .await;
    let created_note = created.note.expect("create response missing note");
    let note_id = created_note.id;

    // Consume the creation event so the following assertion targets only updates.
    let _created_event = next_note_event(&mut websocket).await;

    let updated = request_protobuf::<_, UpdateNoteResponse>(
        &client,
        Method::PATCH,
        &format!("{http_base}/notes/{note_id}"),
        &UpdateNoteRequest {
            title: Some("renamed".to_owned()),
            body: None,
        },
    )
    .await;
    let updated_note = updated.note.expect("update response missing note");
    assert_eq!(updated_note.id, note_id);
    assert_eq!(updated_note.title, "renamed");
    assert_eq!(updated_note.body, "hello body");

    let note_delta = wait_for_note_delta(&mut websocket, note_id).await;
    assert_eq!(note_delta.id, note_id);
    assert_eq!(note_delta.title.as_deref(), Some("renamed"));
    assert_eq!(note_delta.body, None);

    let fetched = decode_protobuf::<GetNoteResponse>(
        client
            .get(format!("{http_base}/notes/{note_id}"))
            .send()
            .await
            .expect("failed to fetch note"),
    )
    .await;
    let fetched_note = fetched.note.expect("get response missing note");
    assert_eq!(fetched_note.title, "renamed");
    assert_eq!(fetched_note.body, "hello body");

    let deleted = decode_protobuf::<DeleteNoteResponse>(
        client
            .delete(format!("{http_base}/notes/{note_id}"))
            .send()
            .await
            .expect("failed to delete note"),
    )
    .await;
    assert_eq!(deleted.id, note_id);

    let listed = decode_protobuf::<ListNotesResponse>(
        client
            .get(format!("{http_base}/notes"))
            .send()
            .await
            .expect("failed to list notes"),
    )
    .await;
    assert!(listed.notes.is_empty());

    server_task.abort();
}

fn spawn_server(listener: TcpListener, app: Router) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = axum::serve(listener, app).await;
        if let Err(error) = result {
            panic!("test server exited unexpectedly: {error}");
        }
    })
}

async fn wait_for_notes_endpoint(port: u16) {
    let client = Client::new();
    let list_notes_url = format!("http://127.0.0.1:{port}/notes");

    for _ in 0..80 {
        if let Ok(response) = client.get(&list_notes_url).send().await
            && response.status() == StatusCode::OK
        {
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }

    panic!("notes endpoint did not become ready in time");
}

async fn request_protobuf<TReq, TRes>(
    client: &Client,
    method: Method,
    url: &str,
    request: &TReq,
) -> TRes
where
    TReq: Message,
    TRes: Message + Default,
{
    let response = client
        .request(method, url)
        .header(reqwest::header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
        .body(request.encode_to_vec())
        .send()
        .await
        .expect("protobuf request failed");

    decode_protobuf(response).await
}

async fn decode_protobuf<T>(response: reqwest::Response) -> T
where
    T: Message + Default,
{
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .bytes()
        .await
        .expect("failed to read protobuf response body");
    T::decode(body).expect("failed to decode protobuf response")
}

async fn wait_for_note_delta(websocket: &mut WsConnection, expected_note_id: i64) -> NoteDelta {
    for _ in 0..8 {
        let event = next_note_event(websocket).await;
        if let Some(note_event::Event::Updated(delta)) = event.event
            && delta.id == expected_note_id
        {
            return delta;
        }
    }

    panic!("did not receive expected note delta event");
}

async fn next_note_event(websocket: &mut WsConnection) -> NoteEvent {
    loop {
        let next_frame = websocket.next().await;
        let frame = next_frame.expect("websocket stream ended");
        let message = frame.expect("websocket frame error");

        match message {
            WsMessage::Binary(payload) => {
                return NoteEvent::decode(payload).expect("failed to decode note event");
            }
            WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            WsMessage::Close(frame) => {
                panic!("websocket closed unexpectedly: {frame:?}");
            }
            WsMessage::Text(_) | WsMessage::Frame(_) => {
                panic!("unexpected non-binary websocket message");
            }
        }
    }
}
