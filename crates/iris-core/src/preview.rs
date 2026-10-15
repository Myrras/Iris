//! Quick Look-style previews: the start of a file, classified as text, an
//! image, binary, or too large to show.
//!
//! Text is recognised by content (no NUL byte in the first few KB, valid
//! UTF-8); images by extension *and* magic bytes, so a renamed binary never
//! reaches an `<img>`. SVG is markup: it is offered as an image only so the
//! UI can render it through an `<img>` data URL (which never runs scripts),
//! and falls back to text when it does not fit.

use base64::Engine;
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::fs::FileSystem;

/// Text is never read past this, whatever the caller's cap: a larger file
/// shows its first MiB with a "truncated" notice.
pub const TEXT_PREVIEW_MAX_BYTES: u64 = 1024 * 1024;

/// The largest `max_bytes` a preview accepts.
pub const PREVIEW_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// How much is read first to tell text from binary (and check magic bytes).
const SNIFF_BYTES: u64 = 8 * 1024;

/// What a preview shows. On the wire, tagged by `kind`:
/// `{ kind: "text", text, truncated, totalSize }`,
/// `{ kind: "image", mime, dataBase64, totalSize }`,
/// `{ kind: "binary", totalSize }` or `{ kind: "tooLarge", totalSize }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Preview {
    Text {
        text: String,
        /// Only the start of the file is in `text`.
        truncated: bool,
        total_size: u64,
    },
    Image {
        mime: String,
        data_base64: String,
        total_size: u64,
    },
    Binary {
        total_size: u64,
    },
    /// An image larger than the cap.
    TooLarge {
        total_size: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageType {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

impl ImageType {
    fn from_path(path: &str) -> Option<Self> {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let (_, ext) = name.rsplit_once('.')?;
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            "svg" => Some(Self::Svg),
            _ => None,
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }

    /// Whether `head` starts like this format.
    fn matches(self, head: &[u8]) -> bool {
        match self {
            Self::Png => head.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpeg => head.starts_with(&[0xFF, 0xD8, 0xFF]),
            Self::Gif => head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a"),
            Self::Webp => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
            Self::Svg => std::str::from_utf8(head).is_ok_and(|t| t.contains("<svg")),
        }
    }
}

/// Preview the file at `path`, reading at most `max_bytes` (and never more
/// than [`TEXT_PREVIEW_MAX_BYTES`] of text).
pub async fn preview<F: FileSystem>(fs: &F, path: &str, max_bytes: u64) -> CoreResult<Preview> {
    if max_bytes == 0 || max_bytes > PREVIEW_MAX_BYTES {
        return Err(CoreError::InvalidInput(
            "the preview size limit is out of range".into(),
        ));
    }
    let head = fs.read_range(path, 0, SNIFF_BYTES.min(max_bytes)).await?;
    let total_size = head.total_size;

    match ImageType::from_path(path) {
        Some(ImageType::Svg) if total_size <= max_bytes => {
            let bytes = read_up_to(fs, path, head.bytes, head.truncated, max_bytes).await?;
            if ImageType::Svg.matches(&bytes) {
                return Ok(image(ImageType::Svg, &bytes, total_size));
            }
            Ok(classify_text(bytes, total_size))
        }
        Some(kind) if kind != ImageType::Svg && kind.matches(&head.bytes) => {
            if total_size > max_bytes {
                return Ok(Preview::TooLarge { total_size });
            }
            let bytes = read_up_to(fs, path, head.bytes, head.truncated, max_bytes).await?;
            Ok(image(kind, &bytes, total_size))
        }
        _ => {
            if head.bytes.contains(&0) {
                return Ok(Preview::Binary { total_size });
            }
            let cap = max_bytes.min(TEXT_PREVIEW_MAX_BYTES);
            let bytes = read_up_to(fs, path, head.bytes, head.truncated, cap).await?;
            Ok(classify_text(bytes, total_size))
        }
    }
}

/// Extend `bytes` (the file's first bytes) to at most `cap` bytes.
async fn read_up_to<F: FileSystem>(
    fs: &F,
    path: &str,
    mut bytes: Vec<u8>,
    more: bool,
    cap: u64,
) -> CoreResult<Vec<u8>> {
    let have = bytes.len() as u64;
    if more && have < cap {
        let rest = fs.read_range(path, have, cap - have).await?;
        bytes.extend_from_slice(&rest.bytes);
    }
    Ok(bytes)
}

fn image(kind: ImageType, bytes: &[u8], total_size: u64) -> Preview {
    Preview::Image {
        mime: kind.mime().to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        total_size,
    }
}

/// Text when `bytes` (the start of a `total_size`-byte file) is NUL-free
/// UTF-8, else binary. A multi-byte character cut off by the cap is dropped.
fn classify_text(bytes: Vec<u8>, total_size: u64) -> Preview {
    if bytes.contains(&0) {
        return Preview::Binary { total_size };
    }
    let truncated = (bytes.len() as u64) < total_size;
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => {
            let err = e.utf8_error();
            // `error_len() == None`: the bytes end mid-character. Only a cut
            // made by the cap is forgiven.
            if !(truncated && err.error_len().is_none()) {
                return Preview::Binary { total_size };
            }
            let valid = err.valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).unwrap_or_default()
        }
    };
    let text = match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    };
    Preview::Text {
        text,
        truncated,
        total_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89,
    ];

    async fn run(name: &str, contents: &[u8], max_bytes: u64) -> Preview {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, contents).unwrap();
        preview(&LocalFs::new(), &path.to_string_lossy(), max_bytes)
            .await
            .unwrap()
    }

    #[test]
    fn wire_shape_is_kind_tagged_camel_case() {
        let json = serde_json::to_value(Preview::Image {
            mime: "image/png".into(),
            data_base64: "AA==".into(),
            total_size: 1,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "image", "mime": "image/png", "dataBase64": "AA==", "totalSize": 1 })
        );
        assert_eq!(
            serde_json::to_value(Preview::TooLarge { total_size: 9 }).unwrap(),
            serde_json::json!({ "kind": "tooLarge", "totalSize": 9 })
        );
    }

    #[tokio::test]
    async fn text_files_preview_as_text() {
        assert_eq!(
            run("notes.txt", "héllo\n".as_bytes(), 1024).await,
            Preview::Text {
                text: "héllo\n".into(),
                truncated: false,
                total_size: 7,
            }
        );
        // A BOM is not shown.
        let Preview::Text { text, .. } = run("bom.txt", b"\xEF\xBB\xBFabc", 1024).await else {
            panic!("text expected");
        };
        assert_eq!(text, "abc");
    }

    #[tokio::test]
    async fn long_text_is_truncated_without_splitting_a_character() {
        // 9 bytes: "ab" + "€" (3 bytes) + "cd" + "é"(2) ; cap at 4 cuts the €.
        let contents = "ab€cdé".as_bytes();
        assert_eq!(
            run("t.log", contents, 4).await,
            Preview::Text {
                text: "ab".into(),
                truncated: true,
                total_size: contents.len() as u64,
            }
        );
    }

    #[tokio::test]
    async fn text_is_capped_at_one_mib() {
        let contents = vec![b'a'; (TEXT_PREVIEW_MAX_BYTES + 10) as usize];
        let Preview::Text {
            text, truncated, ..
        } = run("big.txt", &contents, 10 * 1024 * 1024).await
        else {
            panic!("text expected");
        };
        assert_eq!(text.len() as u64, TEXT_PREVIEW_MAX_BYTES);
        assert!(truncated);
    }

    #[tokio::test]
    async fn nul_bytes_or_invalid_utf8_are_binary() {
        assert_eq!(
            run("a.bin", b"abc\0def", 1024).await,
            Preview::Binary { total_size: 7 }
        );
        assert_eq!(
            run("latin1.txt", b"caf\xe9 au lait", 1024).await,
            Preview::Binary { total_size: 12 }
        );
    }

    #[tokio::test]
    async fn images_need_extension_and_magic_bytes() {
        let Preview::Image {
            mime,
            data_base64,
            total_size,
        } = run("pixel.PNG", PNG_1X1, 1024).await
        else {
            panic!("image expected");
        };
        assert_eq!(mime, "image/png");
        assert_eq!(total_size, PNG_1X1.len() as u64);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data_base64)
                .unwrap(),
            PNG_1X1
        );
        // PNG bytes under another name are just binary.
        assert!(matches!(
            run("pixel.dat", PNG_1X1, 1024).await,
            Preview::Binary { .. }
        ));
        // A .png that is really text is shown as text.
        assert!(matches!(
            run("fake.png", b"not an image", 1024).await,
            Preview::Text { .. }
        ));
        let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
        assert!(matches!(
            run("a.gif", gif, 1024).await,
            Preview::Image { mime, .. } if mime == "image/gif"
        ));
        let webp = b"RIFF\x04\x00\x00\x00WEBPVP8 ";
        assert!(matches!(
            run("a.webp", webp, 1024).await,
            Preview::Image { mime, .. } if mime == "image/webp"
        ));
        assert!(matches!(
            run("a.jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0], 1024).await,
            Preview::Image { mime, .. } if mime == "image/jpeg"
        ));
    }

    #[tokio::test]
    async fn images_over_the_cap_are_too_large() {
        assert_eq!(
            run("pixel.png", PNG_1X1, 16).await,
            Preview::TooLarge {
                total_size: PNG_1X1.len() as u64
            }
        );
    }

    #[tokio::test]
    async fn svg_is_an_image_when_it_fits_and_text_when_not() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;
        assert!(matches!(
            run("icon.svg", svg, 1024).await,
            Preview::Image { mime, .. } if mime == "image/svg+xml"
        ));
        assert!(matches!(
            run("icon.svg", svg, 10).await,
            Preview::Text {
                truncated: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn an_out_of_range_cap_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "x").unwrap();
        let path = path.to_string_lossy();
        assert!(matches!(
            preview(&LocalFs::new(), &path, 0).await,
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            preview(&LocalFs::new(), &path, PREVIEW_MAX_BYTES + 1).await,
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn empty_files_are_empty_text() {
        assert_eq!(
            run("empty", b"", 1024).await,
            Preview::Text {
                text: String::new(),
                truncated: false,
                total_size: 0,
            }
        );
    }
}
