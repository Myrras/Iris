//! Sync exclude patterns: glob-ish name patterns matched against **one path
//! segment** at a time (`node_modules` excludes that folder wherever it is,
//! `*.log` every log file). `*` matches any run of characters (also none),
//! `?` exactly one; everything else matches itself, case-sensitively.

/// Whether the name `name` matches `pattern`.
pub fn matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    // Iterative wildcard match with backtracking to the last `*`.
    let (mut pi, mut ni) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ni));
            pi += 1;
        } else if let Some((sp, sn)) = star {
            // Let the last `*` swallow one more character.
            pi = sp + 1;
            ni = sn + 1;
            star = Some((sp, sn + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// The first of `patterns` that matches `name`.
pub fn first_match<'a>(patterns: &'a [String], name: &str) -> Option<&'a str> {
    patterns
        .iter()
        .find(|p| matches(p, name))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_patterns_match_the_whole_name() {
        assert!(matches(".git", ".git"));
        assert!(!matches(".git", ".github"));
        assert!(!matches(".git", "x.git"));
        assert!(!matches("Thumbs.db", "thumbs.db"));
    }

    #[test]
    fn stars_match_any_run() {
        assert!(matches("*.log", "app.log"));
        assert!(matches("*.log", ".log"));
        assert!(!matches("*.log", "app.log.1"));
        assert!(matches("*", "anything"));
        assert!(matches("build*", "build"));
        assert!(matches("a*b*c", "a-x-b-y-c"));
        assert!(!matches("a*b*c", "a-x-c-y-b"));
    }

    #[test]
    fn question_marks_match_one_character() {
        assert!(matches("file?.txt", "file1.txt"));
        assert!(!matches("file?.txt", "file.txt"));
        assert!(!matches("file?.txt", "file12.txt"));
        assert!(matches("?é", "aé"));
    }

    #[test]
    fn the_first_matching_pattern_is_reported() {
        let patterns = vec!["*.tmp".to_string(), "cache".to_string()];
        assert_eq!(first_match(&patterns, "cache"), Some("cache"));
        assert_eq!(first_match(&patterns, "a.tmp"), Some("*.tmp"));
        assert_eq!(first_match(&patterns, "a.txt"), None);
    }
}
