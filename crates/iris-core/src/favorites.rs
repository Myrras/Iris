//! Favorite folders: the Local ones live in the settings
//! ([`crate::IrisSettings::local_favorites`]), each connection's remote ones
//! in its profile ([`crate::ConnectionProfile::favorites`]).
//!
//! A list only changes through its own call ([`crate::Core::set_local_favorites`],
//! [`crate::Core::set_profile_favorites`]), which validates it strictly
//! ([`normalize`]). Saving the settings or a profile from a form keeps the
//! stored list, so a form opened before a favorite was added can never drop
//! it. Lists read from disk are tidied leniently ([`sanitize`]): a bad entry
//! from a hand edit is dropped instead of discarding the whole file.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

/// The most favorites one list (Local, or one connection's) holds.
pub const MAX_FAVORITES: usize = 200;
/// The longest favorite label, in characters.
pub const MAX_FAVORITE_LABEL_LEN: usize = 255;

/// One favorite folder: `{ "path", "label" }` on the wire and on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// The folder: an absolute local path, or a remote path from `/`.
    pub path: String,
    /// Shown instead of the folder's name; `None` = derived from the path
    /// by the UI.
    #[serde(default)]
    pub label: Option<String>,
}

/// Which filesystem a favorite list addresses: it decides what counts as an
/// absolute path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FavoriteSide {
    Local,
    Remote,
}

/// The path as stored, or why it cannot be a favorite.
fn tidy_path(path: String, side: FavoriteSide) -> Result<String, &'static str> {
    if path.contains('\0') {
        return Err("a favorite path cannot contain a NUL character");
    }
    match side {
        FavoriteSide::Local if Path::new(&path).is_absolute() => Ok(path),
        FavoriteSide::Local => Err("a local favorite needs an absolute path"),
        FavoriteSide::Remote if path.starts_with('/') => {
            // `/var/www/` and `/var/www` are one folder.
            let trimmed = path.trim_end_matches('/');
            Ok(if trimmed.is_empty() { "/" } else { trimmed }.to_string())
        }
        FavoriteSide::Remote => Err("a remote favorite needs a path starting with /"),
    }
}

/// The label as stored (trimmed, blank = `None`), or why it is refused.
fn tidy_label(label: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(label) = label else { return Ok(None) };
    let label = label.trim();
    if label.is_empty() {
        return Ok(None);
    }
    if label.chars().count() > MAX_FAVORITE_LABEL_LEN {
        return Err("a favorite label can be at most 255 characters");
    }
    Ok(Some(label.to_string()))
}

/// Validate a list the user set: absolute paths, no folder twice, labels
/// trimmed and ≤ [`MAX_FAVORITE_LABEL_LEN`], at most [`MAX_FAVORITES`].
/// Anything else is `InvalidInput`.
pub(crate) fn normalize(list: Vec<Favorite>, side: FavoriteSide) -> CoreResult<Vec<Favorite>> {
    if list.len() > MAX_FAVORITES {
        return Err(CoreError::InvalidInput(format!(
            "there can be at most {MAX_FAVORITES} favorites"
        )));
    }
    let invalid = |msg: &str| CoreError::InvalidInput(msg.to_string());
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for fav in list {
        let path = tidy_path(fav.path, side).map_err(invalid)?;
        let label = tidy_label(fav.label).map_err(invalid)?;
        if !seen.insert(path.clone()) {
            return Err(invalid("that folder is already a favorite"));
        }
        out.push(Favorite { path, label });
    }
    Ok(out)
}

/// Tidy a list read from disk: entries [`normalize`] would refuse are
/// dropped (a refused label only loses the label), repeats keep the first,
/// and the list is cut at [`MAX_FAVORITES`].
pub(crate) fn sanitize(list: Vec<Favorite>, side: FavoriteSide) -> Vec<Favorite> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter_map(|fav| {
            let path = tidy_path(fav.path, side).ok()?;
            let label = tidy_label(fav.label).unwrap_or(None);
            seen.insert(path.clone())
                .then_some(Favorite { path, label })
        })
        .take(MAX_FAVORITES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fav(path: &str, label: Option<&str>) -> Favorite {
        Favorite {
            path: path.into(),
            label: label.map(String::from),
        }
    }

    /// An absolute local path on this OS.
    fn local(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn wire_shape_is_camel_case_and_label_is_optional() {
        let json = serde_json::to_value(fav("/var/www", Some("Site"))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "path": "/var/www", "label": "Site" })
        );
        let back: Favorite = serde_json::from_str(r#"{"path":"/srv"}"#).unwrap();
        assert_eq!(back, fav("/srv", None));
    }

    #[test]
    fn remote_paths_must_start_at_the_root() {
        let ok = normalize(
            vec![fav("/var/www/", None), fav("/", None), fav("//", None)],
            FavoriteSide::Remote,
        );
        // `/` and `//` are the same folder.
        assert_eq!(ok.unwrap_err().kind(), "invalidInput");
        let ok = normalize(
            vec![fav("/var/www/", None), fav("/", None)],
            FavoriteSide::Remote,
        )
        .unwrap();
        assert_eq!(ok, vec![fav("/var/www", None), fav("/", None)]);
        for bad in ["var/www", "", "~/www", "/a\0b"] {
            let err = normalize(vec![fav(bad, None)], FavoriteSide::Remote).unwrap_err();
            assert_eq!(err.kind(), "invalidInput", "{bad:?}");
        }
    }

    #[test]
    fn local_paths_must_be_absolute() {
        let abs = local("projects");
        let ok = normalize(vec![fav(&abs, None)], FavoriteSide::Local).unwrap();
        assert_eq!(ok, vec![fav(&abs, None)]);
        for bad in ["projects", "", "./x"] {
            let err = normalize(vec![fav(bad, None)], FavoriteSide::Local).unwrap_err();
            assert_eq!(err.kind(), "invalidInput", "{bad:?}");
        }
    }

    #[test]
    fn labels_are_trimmed_blank_means_none_and_long_ones_are_refused() {
        let ok = normalize(
            vec![fav("/a", Some("  Site  ")), fav("/b", Some("   "))],
            FavoriteSide::Remote,
        )
        .unwrap();
        assert_eq!(ok, vec![fav("/a", Some("Site")), fav("/b", None)]);
        let max = "é".repeat(MAX_FAVORITE_LABEL_LEN);
        assert!(normalize(vec![fav("/a", Some(&max))], FavoriteSide::Remote).is_ok());
        let long = format!("{max}x");
        let err = normalize(vec![fav("/a", Some(&long))], FavoriteSide::Remote).unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
    }

    #[test]
    fn a_folder_cannot_be_a_favorite_twice() {
        let err = normalize(
            vec![fav("/a", None), fav("/a/", Some("again"))],
            FavoriteSide::Remote,
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
    }

    #[test]
    fn at_most_two_hundred() {
        let list = |n: usize| (0..n).map(|i| fav(&format!("/f{i}"), None)).collect();
        assert_eq!(
            normalize(list(MAX_FAVORITES), FavoriteSide::Remote)
                .unwrap()
                .len(),
            MAX_FAVORITES
        );
        let err = normalize(list(MAX_FAVORITES + 1), FavoriteSide::Remote).unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
    }

    #[test]
    fn sanitize_drops_what_normalize_refuses() {
        let long = "x".repeat(MAX_FAVORITE_LABEL_LEN + 1);
        let list = vec![
            fav("/a", Some(" A ")),
            fav("relative", None),
            fav("/a/", Some("repeat")),
            fav("/b", Some(&long)),
        ];
        assert_eq!(
            sanitize(list, FavoriteSide::Remote),
            vec![fav("/a", Some("A")), fav("/b", None)]
        );
        let many = (0..MAX_FAVORITES + 5)
            .map(|i| fav(&format!("/f{i}"), None))
            .collect();
        assert_eq!(sanitize(many, FavoriteSide::Remote).len(), MAX_FAVORITES);
    }
}
