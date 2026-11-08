//! A mail picture the webview refused (2026-10-29, Claude's logo): a server
//! that sends `Cross-Origin-Resource-Policy: same-origin` lets only its own
//! pages show the image, and Mailroom loads mail pictures straight from the
//! sender. Webmail never notices, as it shows every picture through its own
//! proxy. The page asks for such a picture here, once the reader has allowed
//! pictures, and gets it back as a data URL.
//!
//! This request goes out from the app, not the page, so it is held tighter:
//! https only, never to this machine or the local network (the name is
//! resolved, checked and pinned, so a rebind can't move it), at most three
//! redirects with each checked again, no cookies, a time limit, a size cap,
//! and only raster pictures, known by their first bytes, come back.

use base64::Engine;
use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

/// The picture at `url` as a data URL.
pub fn fetch(url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(url.trim()).map_err(|_| "That isn't a picture address.".to_string())?;
    for _ in 0..=MAX_REDIRECTS {
        let (host, addr) = public_target(&url)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .build()
            .map_err(|err| err.to_string())?;
        let response = client
            .get(url.clone())
            .header("Accept", "image/png,image/jpeg,image/gif,image/webp,image/bmp")
            .send()
            .map_err(|_| "The picture could not be fetched.".to_string())?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| url.join(value).ok())
                .ok_or("The picture's server sent a bad redirect.")?;
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("The picture's server answered {}.", response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "The picture could not be read.".to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("The picture is too large.".into());
        }
        let kind = sniff(&bytes).ok_or("That isn't a picture Mailroom shows.")?;
        return Ok(format!("data:{};base64,{}", kind, base64::engine::general_purpose::STANDARD.encode(&bytes)));
    }
    Err("The picture's server redirected too many times.".into())
}

/// The host to connect to and the public address it is pinned to.
pub(crate) fn public_target(url: &reqwest::Url) -> Result<(String, SocketAddr), String> {
    if url.scheme() != "https" {
        return Err("Only https pictures are fetched.".into());
    }
    if !crate::unsubscribe::public_host(url) {
        return Err("Pictures on this computer or the local network aren't fetched.".into());
    }
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "The picture's server could not be found.".to_string())?
        .collect();
    // Every address must be public: one private answer among public ones
    // could be the one used.
    if addrs.is_empty() || !addrs.iter().all(|addr| crate::unsubscribe::public_ip(addr.ip())) {
        return Err("Pictures on this computer or the local network aren't fetched.".into());
    }
    Ok((host, addrs[0]))
}

/// The picture type from its first bytes; never SVG, which can carry script.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        Some("image/bmp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(url: &str) -> Result<(String, SocketAddr), String> {
        public_target(&reqwest::Url::parse(url).unwrap())
    }

    #[test]
    fn only_https_to_a_public_host() {
        assert!(target("http://example.com/a.png").unwrap_err().contains("https"));
        for local in [
            "https://localhost/a.png",
            "https://127.0.0.1/a.png",
            "https://10.0.0.5/a.png",
            "https://192.168.1.1/a.png",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/a.png",
            "https://[::1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[::ffff:192.168.0.1]/a.png",
            "https://[64:ff9b::a00:1]/a.png",
            "https://[64:ff9b::7f00:1]/a.png",
            "https://[2002:c0a8:101::1]/a.png",
            "https://[fec0::1]/a.png",
            "https://[ff02::1]/a.png",
            "https://224.0.0.1/a.png",
            "https://240.0.0.1/a.png",
            "https://198.18.0.1/a.png",
            "https://192.0.0.8/a.png",
            "https://printer.local/a.png",
            "https://intranet/a.png",
        ] {
            assert!(target(local).unwrap_err().contains("local network"), "{local}");
        }
        // A public address needs no lookup and is pinned as given.
        let (host, addr) = target("https://1.1.1.1/a.png").unwrap();
        assert_eq!((host.as_str(), addr.to_string().as_str()), ("1.1.1.1", "1.1.1.1:443"));
    }

    #[test]
    fn fetch_refuses_before_connecting() {
        assert!(fetch("not a url").is_err());
        assert!(fetch("https://127.0.0.1:9/x.png").unwrap_err().contains("local network"));
        assert!(fetch("file:///etc/passwd").unwrap_err().contains("https"));
    }

    // Over the network: cargo test remoteimg -- --ignored
    #[test]
    #[ignore]
    fn a_same_origin_picture_comes_back() {
        let url = fetch("https://claude.ai/images/email/claude_logo_chip.png").unwrap();
        assert!(url.starts_with("data:image/png;base64,iVBOR"), "{}", &url[..40.min(url.len())]);
    }

    #[test]
    fn pictures_are_known_by_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0...."), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"), None);
        assert_eq!(sniff(b"<html>"), None);
        assert_eq!(sniff(b""), None);
    }
}
