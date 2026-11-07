mod veilid;
mod web;

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, UnixListener, UnixStream},
    sync::watch,
    task::JoinSet,
};
use veilid::{deadline, validate_content, Error, Node, Result};

const USAGE: &str =
    "Usage: murmur [--data-dir PATH] serve\n       murmur [--data-dir PATH] post \"message\"\n       murmur [--data-dir PATH] export BACKUP_FILE (passphrase on stdin)";
const IPC_LIMIT: usize = 8192;

#[tokio::main]
async fn main() -> ExitCode {
    veilid_core::tracing_subscriber::fmt()
        .with_target(false)
        .init();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments == ["--help"] || arguments == ["-h"] {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match run(arguments).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("murmur: {error}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve,
    Post(String),
    Export(PathBuf),
}

#[derive(Debug)]
struct Args {
    directory: PathBuf,
    command: Command,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
struct Published {
    record_key: String,
    index: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishRequest {
    content: String,
}

fn parse_args(mut args: Vec<String>) -> Result<Args> {
    let directory = if args.first().is_some_and(|arg| arg == "--data-dir") {
        if args.len() < 3 {
            return Err(Error::new(400, USAGE));
        }
        let directory = PathBuf::from(&args[1]);
        args.drain(..2);
        directory
    } else {
        PathBuf::from("./murmur-data")
    };
    let command = match args.as_slice() {
        [command] if command == "serve" => Command::Serve,
        [command, content] if command == "post" => Command::Post(content.clone()),
        [command, output] if command == "export" => Command::Export(PathBuf::from(output)),
        _ => return Err(Error::new(400, USAGE)),
    };
    Ok(Args { directory, command })
}

fn lock_directory(directory: &Path) -> Result<File> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory.join("server.lock"))?;
    file.try_lock()
        .map_err(|_| Error::new(409, "data directory is locked by another server"))?;
    Ok(file)
}

async fn read_line(stream: &mut BufReader<UnixStream>) -> Result<Vec<u8>> {
    deadline(
        async {
            let mut bytes = Vec::new();
            stream
                .take((IPC_LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await?;
            if bytes.len() > IPC_LIMIT || bytes.last() != Some(&b'\n') {
                return Err(Error::new(
                    400,
                    "IPC request must be a JSON line of at most 8192 bytes",
                ));
            }
            Ok(bytes)
        },
        10,
    )
    .await
}

async fn handle_client<F, Fut>(stream: UnixStream, publish: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Published>>,
{
    let mut stream = BufReader::new(stream);
    let request = async {
        let bytes = read_line(&mut stream).await?;
        let request: PublishRequest = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new(400, "invalid IPC publish request"))?;
        validate_content(&request.content)?;
        Ok(request)
    }
    .await;
    let reply = match request {
        Ok(request) => deadline(publish(request.content), 180).await,
        Err(error) => Err(error),
    };
    send_reply(stream.get_mut(), &reply).await
}

async fn send_reply(stream: &mut UnixStream, reply: &Result<Published>) -> Result<()> {
    let mut bytes =
        serde_json::to_vec(reply).map_err(|_| Error::new(500, "cannot encode IPC reply"))?;
    bytes.push(b'\n');
    deadline(
        async { stream.write_all(&bytes).await.map_err(Into::into) },
        10,
    )
    .await
}

async fn post_client(path: &Path, content: String) -> Result<Published> {
    validate_content(&content)?;
    let mut stream = UnixStream::connect(path).await.map_err(|error| {
        Error::new(
            503,
            format!("cannot connect to local server ({error}); run serve with the same --data-dir"),
        )
    })?;
    let mut bytes = serde_json::to_vec(&PublishRequest { content })
        .map_err(|_| Error::new(500, "cannot encode publish request"))?;
    bytes.push(b'\n');
    deadline(
        async { stream.write_all(&bytes).await.map_err(Into::into) },
        10,
    )
    .await?;
    deadline(async {
        let stream = BufReader::new(stream);
        let mut bytes = Vec::new();
        stream.take((IPC_LIMIT + 1) as u64).read_until(b'\n', &mut bytes).await?;
        if bytes.len() > IPC_LIMIT || bytes.last() != Some(&b'\n') {
            return Err(Error::new(502, "invalid IPC reply"));
        }
        serde_json::from_slice::<Result<Published>>(&bytes)
            .map_err(|_| Error::new(502, "invalid IPC reply"))?
    }, 200).await.map_err(|error| Error::new(error.status, format!(
        "{error}. If publication started, its outcome may be uncertain; inspect your feed before resending."
    )))
}

struct SocketFile(PathBuf);

impl Drop for SocketFile {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            veilid_core::tracing::error!(%error, "cannot remove owned socket");
        }
    }
}

fn bind_socket(path: PathBuf) -> Result<(UnixListener, SocketFile)> {
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(&path)?,
        Ok(_) => {
            return Err(Error::new(
                500,
                "socket path contains a non-socket file; refusing to remove it",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(&path)?;
    let guard = SocketFile(path);
    fs::set_permissions(&guard.0, fs::Permissions::from_mode(0o600))?;
    Ok((listener, guard))
}

async fn ipc_server<F, Fut>(
    listener: UnixListener,
    publish: F,
    mut stop: watch::Receiver<bool>,
) -> Result<()>
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Published>> + Send,
{
    let publish = Arc::new(publish);
    let mut clients = JoinSet::new();
    let mut result = Ok(());
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
            accepted = listener.accept() => {
                let (mut stream, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        result = Err(error.into());
                        break;
                    }
                };
                if clients.len() >= 8 {
                    if let Err(error) = send_reply(&mut stream, &Err(Error::new(503, "publisher busy; retry later"))).await {
                        veilid_core::tracing::warn!(%error, "busy IPC client disconnected");
                    }
                    continue;
                }
                let publish = publish.clone();
                clients.spawn(async move {
                    handle_client(stream, |content| publish(content)).await
                });
            }
            Some(result) = clients.join_next(), if !clients.is_empty() => log_client(result),
        }
    }
    while let Some(result) = clients.join_next().await {
        log_client(result);
    }
    result
}

fn log_client(result: std::result::Result<Result<()>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => veilid_core::tracing::warn!(%error, "IPC client failed"),
        Err(error) => veilid_core::tracing::error!(%error, "IPC task failed"),
    }
}

async fn shutdown_signal() -> Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result?,
        _ = terminate.recv() => {}
    }
    Ok(())
}

async fn run(arguments: Vec<String>) -> Result<()> {
    let args = parse_args(arguments)?;
    match args.command {
        Command::Post(content) => {
            let published = post_client(&args.directory.join("murmur.sock"), content).await?;
            println!(
                "Published post {} on {}",
                published.index, published.record_key
            );
            return Ok(());
        }
        Command::Export(output) => {
            use std::io::{IsTerminal, Read};
            if std::io::stdin().is_terminal() {
                return Err(Error::new(
                    400,
                    "Pipe the backup passphrase on standard input, not the command line",
                ));
            }
            let mut passphrase = zeroize::Zeroizing::new(String::new());
            std::io::stdin()
                .take(1025)
                .read_to_string(&mut passphrase)?;
            murmur_core::vault::validate_passphrase(&passphrase)
                .map_err(murmur_core::Error::from)?;
            let _lock = lock_directory(&args.directory)?;
            veilid::export_identity(&args.directory, &output, &passphrase)?;
            println!("Encrypted backup saved to {}", output.display());
            return Ok(());
        }
        Command::Serve => {}
    }
    let _lock = lock_directory(&args.directory)?;
    let directory = fs::canonicalize(&args.directory)?;
    let p2p_port = match std::env::var("MURMUR_P2P_PORT") {
        Ok(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| Error::new(400, "MURMUR_P2P_PORT must be a nonzero port"))?,
        Err(std::env::VarError::NotPresent) => 5150,
        Err(_) => return Err(Error::new(400, "MURMUR_P2P_PORT must be UTF-8")),
    };
    let http_address = match std::env::var("MURMUR_HTTP_ADDR") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => "0.0.0.0:8080".into(),
        Err(_) => return Err(Error::new(400, "MURMUR_HTTP_ADDR must be UTF-8")),
    };
    let http = TcpListener::bind(&http_address).await?;
    let (ipc, _socket) = bind_socket(directory.join("murmur.sock"))?;
    veilid_core::tracing::info!(
        p2p_port,
        "starting embedded Veilid node; waiting for attachment"
    );
    let (stop_tx, stop_rx) = watch::channel(false);
    let mut signal = Box::pin(shutdown_signal());
    let mut startup = Box::pin(Node::start(directory, p2p_port, stop_rx.clone()));
    let node = tokio::select! {
        result = &mut startup => result?,
        result = &mut signal => {
            stop_tx.send_replace(true);
            match startup.await {
                Ok(node) => node.shutdown().await,
                Err(error) => veilid_core::tracing::info!(%error, "stopped during startup"),
            }
            return result;
        }
    };
    veilid_core::tracing::info!(record_key = %node.key(), %http_address, "Murmur ready (read-only HTTP)");
    let http_stop = stop_rx.clone();
    let http_node = node.clone();
    let mut http_task = tokio::spawn(async move {
        let mut stop = http_stop;
        axum::serve(http, web::router(http_node))
            .with_graceful_shutdown(async move {
                let _ = stop.wait_for(|stop| *stop).await;
            })
            .await
            .map_err(Error::from)
    });
    let publisher = node.clone();
    let mut ipc_task = tokio::spawn(ipc_server(
        ipc,
        move |content| {
            let node = publisher.clone();
            async move {
                let post = node.publish(content).await?;
                Ok(Published {
                    record_key: node.key().to_string(),
                    index: post.index,
                })
            }
        },
        stop_rx,
    ));
    let mut http_finished = false;
    let mut ipc_finished = false;
    let mut result = tokio::select! {
        result = &mut signal => result,
        result = &mut http_task => {
            http_finished = true;
            service_result(result)
        }
        result = &mut ipc_task => {
            ipc_finished = true;
            service_result(result)
        }
    };
    stop_tx.send_replace(true);
    if !http_finished {
        if let Err(error) = service_result(http_task.await) {
            veilid_core::tracing::error!(%error, "HTTP shutdown failed");
            result = Err(error);
        }
    }
    if !ipc_finished {
        if let Err(error) = service_result(ipc_task.await) {
            veilid_core::tracing::error!(%error, "IPC shutdown failed");
            result = Err(error);
        }
    }
    node.shutdown().await;
    result
}

fn service_result(result: std::result::Result<Result<()>, tokio::task::JoinError>) -> Result<()> {
    result.map_err(|error| Error::new(500, format!("service task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };

    #[test]
    fn parses_offline_backup_export() {
        let args = parse_args(vec!["export".into(), "identity.murmur".into()]).unwrap();
        assert_eq!(
            args.command,
            Command::Export(PathBuf::from("identity.murmur"))
        );
    }

    #[test]
    fn parses_only_supported_cli_commands() {
        let args = parse_args(vec![
            "--data-dir".into(),
            "/tmp/example".into(),
            "post".into(),
            "hello world".into(),
        ])
        .unwrap();
        assert_eq!(args.directory, PathBuf::from("/tmp/example"));
        assert_eq!(args.command, Command::Post("hello world".into()));
        assert_eq!(
            parse_args(vec!["serve".into()]).unwrap().command,
            Command::Serve
        );
        assert!(parse_args(vec![]).is_err());
        assert!(parse_args(vec!["post".into()]).is_err());
        assert!(parse_args(vec!["post".into(), "a".into(), "b".into()]).is_err());
        assert!(parse_args(vec!["--data-dir".into()]).is_err());
    }

    #[test]
    fn directory_lock_excludes_second_server_and_preserves_private_mode() {
        let temp = tempfile::tempdir().unwrap();
        let lock = lock_directory(temp.path()).unwrap();
        assert_eq!(
            std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(lock_directory(temp.path()).is_err());
        drop(lock);
        assert!(lock_directory(temp.path()).is_ok());
    }

    #[tokio::test]
    async fn cli_forwards_to_local_publisher_and_surfaces_errors() {
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("test.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_client(stream, |content| async move {
                assert_eq!(content, "hello");
                Ok(Published {
                    record_key: "test-key".into(),
                    index: 3,
                })
            })
            .await
            .unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            handle_client(stream, |_| async { Err(Error::new(503, "detached")) })
                .await
                .unwrap();
        });
        assert_eq!(post_client(&socket, "hello".into()).await.unwrap().index, 3);
        assert_eq!(
            post_client(&socket, "again".into())
                .await
                .unwrap_err()
                .status,
            503
        );
        server.await.unwrap();
        assert!(
            post_client(&temp.path().join("absent.sock"), "hello".into())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ipc_rejects_malformed_blank_and_oversized_requests_without_publishing() {
        for request in [
            b"not json\n".to_vec(),
            b"{\"content\":\"  \"}\n".to_vec(),
            vec![b'x'; 8193],
        ] {
            let (mut client, server) = UnixStream::pair().unwrap();
            let task = tokio::spawn(async move {
                handle_client(server, |_| async {
                    panic!("invalid request reached publisher")
                })
                .await
                .unwrap();
            });
            client.write_all(&request).await.unwrap();
            client.shutdown().await.unwrap();
            let mut line = String::new();
            BufReader::new(client).read_line(&mut line).await.unwrap();
            let reply: Result<Published> = serde_json::from_str(&line).unwrap();
            assert_eq!(reply.unwrap_err().status, 400);
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn disconnected_busy_client_does_not_stop_server_or_abort_publishers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (stop_tx, stop_rx) = watch::channel(false);
        let (started_tx, mut started_rx) = tokio::sync::mpsc::channel(8);
        let finish = Arc::new(tokio::sync::Semaphore::new(0));
        let gate = finish.clone();
        let server = tokio::spawn(ipc_server(
            listener,
            move |_| {
                let started = started_tx.clone();
                let finish = gate.clone();
                async move {
                    started.send(()).await.unwrap();
                    let _permit = finish.acquire().await.unwrap();
                    Ok(Published {
                        record_key: "test".into(),
                        index: 0,
                    })
                }
            },
            stop_rx,
        ));
        let mut clients = Vec::new();
        for _ in 0..8 {
            let mut client = UnixStream::connect(&path).await.unwrap();
            client
                .write_all(b"{\"content\":\"hello\"}\n")
                .await
                .unwrap();
            clients.push(client);
        }
        for _ in 0..8 {
            started_rx.recv().await.unwrap();
        }
        drop(UnixStream::connect(&path).await.unwrap());
        let mut reader = BufReader::new(UnixStream::connect(&path).await.unwrap());
        let reply = read_line(&mut reader).await.unwrap();
        let reply: Result<Published> = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply.unwrap_err().status, 503);
        stop_tx.send_replace(true);
        finish.add_permits(8);
        for client in clients {
            let reply = read_line(&mut BufReader::new(client)).await.unwrap();
            assert!(serde_json::from_slice::<Result<Published>>(&reply)
                .unwrap()
                .is_ok());
        }
        server.await.unwrap().unwrap();
    }
}
