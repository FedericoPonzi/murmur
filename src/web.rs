use crate::veilid::{Error, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use murmur_model::Feed;
use serde::Serialize;
use std::{future::Future, sync::Arc};
use veilid_core::RecordKey;

#[derive(Clone, Serialize)]
pub struct Me {
    pub record_key: String,
    pub author_name: String,
    pub bio: String,
}

pub trait FeedSource: Send + Sync + 'static {
    fn me(&self) -> Me;
    fn feed(self: Arc<Self>, key: RecordKey) -> impl Future<Output = Result<Feed>> + Send;
}

impl FeedSource for crate::veilid::Node {
    fn me(&self) -> Me {
        Me {
            record_key: self.key().to_string(),
            author_name: self.config.author_name.clone(),
            bio: self.config.bio.clone(),
        }
    }

    async fn feed(self: Arc<Self>, key: RecordKey) -> Result<Feed> {
        crate::veilid::Node::feed(self, key).await
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        veilid_core::tracing::warn!(status = self.status, error = %self, "HTTP request failed");
        (status, Json(serde_json::json!({ "error": self.error }))).into_response()
    }
}

pub fn router<S: FeedSource>(source: Arc<S>) -> Router {
    Router::new()
        .route("/", get(|| async { Html(include_str!("../index.html")) }))
        .route("/api/me", get(me::<S>))
        .route("/api/feed/{dht_key}", get(feed::<S>))
        .with_state(source)
}

async fn me<S: FeedSource>(State(source): State<Arc<S>>) -> Json<Me> {
    Json(source.me())
}

async fn feed<S: FeedSource>(
    State(source): State<Arc<S>>,
    Path(key): Path<String>,
) -> Result<Json<Feed>> {
    let key = key
        .parse::<RecordKey>()
        .map_err(|_| Error::new(400, "invalid Veilid RecordKey"))?;
    source.feed(key).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use murmur_model::{Metadata, Post};
    use tower::ServiceExt;

    struct FakeSource {
        status: Option<u16>,
    }

    const KEY: &str = "VLD0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    impl FeedSource for FakeSource {
        fn me(&self) -> Me {
            Me {
                record_key: KEY.into(),
                author_name: "Reader".into(),
                bio: "<b>literal</b>".into(),
            }
        }

        async fn feed(self: Arc<Self>, key: RecordKey) -> Result<Feed> {
            if let Some(status) = self.status {
                return Err(Error::new(status, "upstream failed"));
            }
            Ok(Feed {
                record_key: key.to_string(),
                metadata: Metadata {
                    author_name: "Reader".into(),
                    bio: String::new(),
                    latest_post_index: None,
                },
                posts: Vec::<Post>::new(),
            })
        }
    }

    async fn request(path: &str, status: Option<u16>) -> axum::response::Response {
        router(Arc::new(FakeSource { status }))
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn exposes_public_identity_empty_feed_and_html_without_writer() {
        let response = request("/api/me", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["record_key"], KEY);
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(value.get("writer").is_none());
        let response = request(&format!("/api/feed/{KEY}"), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["posts"].as_array().unwrap().is_empty());
        let response = request("/", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
    }

    #[tokio::test]
    async fn returns_explicit_input_and_upstream_errors() {
        assert_eq!(
            request("/api/feed/not-a-key", None).await.status(),
            StatusCode::BAD_REQUEST
        );
        for status in [404, 502, 503, 504] {
            let response = request(&format!("/api/feed/{KEY}"), Some(status)).await;
            assert_eq!(response.status().as_u16(), status);
            let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["error"], "upstream failed");
        }
    }

    #[tokio::test]
    async fn http_never_accepts_publishing() {
        let response = router(Arc::new(FakeSource { status: None }))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/post")
                    .body(Body::from("{\"content\":\"hello\"}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
