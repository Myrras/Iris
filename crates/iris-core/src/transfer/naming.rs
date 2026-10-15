//! File names for transfers: the "keep both" name and the check that a
//! name from a listing is safe to create.

/// The `n`th "keep both" name for `name`: `report (2).pdf`, `report (3).pdf`
/// and so on. Only the last extension counts (`archive.tar (2).gz`), and a
/// dotfile's leading dot is not an extension (`.env (2)`).
pub fn keep_both_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => {
            format!("{} ({n}){}", &name[..dot], &name[dot..])
        }
        _ => format!("{name} ({n})"),
    }
}

/// Whether `name` is a single plain path segment: not empty, not `.` or
/// `..`, and without separators. A listing from a misbehaving server could
/// otherwise make a download write outside the folder it was aimed at.
pub(crate) fn is_safe_name(name: &str) -> bool {
    let bad_char = |c: char| c == '/' || c == '\0' || (cfg!(windows) && (c == '\\' || c == ':'));
    !name.is_empty() && name != "." && name != ".." && !name.contains(bad_char)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_both_numbers_before_the_extension() {
        assert_eq!(keep_both_name("report.pdf", 2), "report (2).pdf");
        assert_eq!(keep_both_name("report.pdf", 3), "report (3).pdf");
    }

    #[test]
    fn keep_both_only_uses_the_last_extension() {
        assert_eq!(keep_both_name("archive.tar.gz", 2), "archive.tar (2).gz");
    }

    #[test]
    fn keep_both_treats_dotfiles_as_names() {
        assert_eq!(keep_both_name(".env", 2), ".env (2)");
        assert_eq!(keep_both_name(".config.json", 2), ".config (2).json");
    }

    #[test]
    fn keep_both_without_an_extension() {
        assert_eq!(keep_both_name("Makefile", 2), "Makefile (2)");
        assert_eq!(keep_both_name("trailing.", 2), "trailing. (2)");
    }

    #[test]
    fn unsafe_names_are_refused() {
        assert!(is_safe_name("notes.txt"));
        assert!(is_safe_name(".env"));
        for bad in ["", ".", "..", "a/b", "../x", "nul\0"] {
            assert!(!is_safe_name(bad), "{bad:?}");
        }
    }
}
