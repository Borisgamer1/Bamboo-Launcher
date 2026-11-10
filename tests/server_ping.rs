//! Server-Ping gegen lokale Mock-Server: glücklicher Pfad und stummer Port.

use bamboo_launcher::server_ping::ping;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn varint(mut value: i32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

fn status_packet(json: &str) -> Vec<u8> {
    let mut body = varint(0);
    body.extend(varint(json.len() as i32));
    body.extend_from_slice(json.as_bytes());
    let mut packet = varint(body.len() as i32);
    packet.extend(body);
    packet
}

async fn listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("Port");
    let port = listener.local_addr().expect("Adresse").port();
    (listener, port)
}

#[tokio::test]
async fn liest_die_status_antwort() {
    let (listener, port) = listener().await;
    let json = r#"{"version":{"name":"1.21.6","protocol":767},"players":{"online":3,"max":20},"description":{"text":"Hallo","extra":[{"text":" Welt"}]},"favicon":"data:image/png;base64,AA"}"#;
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("Verbindung");
        let mut buffer = [0u8; 1024];
        let _ = socket.read(&mut buffer).await;
        socket.write_all(&status_packet(json)).await.expect("Antwort");
    });

    let value = ping(&format!("127.0.0.1:{port}")).await.expect("online");
    assert_eq!(value["online"], true);
    assert_eq!(value["playersOnline"], 3);
    assert_eq!(value["playersMax"], 20);
    assert_eq!(value["motd"], "Hallo Welt");
    assert_eq!(value["version"], "1.21.6");
    assert_eq!(value["icon"], "data:image/png;base64,AA");
}

#[tokio::test]
async fn stummer_port_bekommt_ein_zeitlimit() {
    let (listener, port) = listener().await;
    tokio::spawn(async move {
        // Verbindung annehmen, nie antworten: genau der Fall, der die
        // Oberfläche vorher hängen ließ.
        let (_socket, _) = listener.accept().await.expect("Verbindung");
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    let started = Instant::now();
    let result = ping(&format!("127.0.0.1:{port}")).await;
    assert!(result.is_err(), "stummer Port darf nicht online sein");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "Ping hing {} s",
        started.elapsed().as_secs_f32()
    );
}

#[tokio::test]
async fn geschlossener_port_ist_ein_fehler() {
    let (listener, port) = listener().await;
    drop(listener);
    assert!(ping(&format!("127.0.0.1:{port}")).await.is_err());
}
