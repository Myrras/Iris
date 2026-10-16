//! The comparison at the heart of a sync, as a **pure function** over two
//! walked trees: no filesystem, no network, so every rule is unit-tested.
//!
//! Both trees are lists of entries relative to the synced folders. They are
//! matched by relative path and every path lands in one [`SyncGroup`]:
//!
//! - only on the source → `new` (a folder too, so empty ones can be made);
//! - a file on both → by the [`CompareRule`] (`changed`, `same`,
//!   `targetNewer`, `differentSizeSameDate`); `same` is only counted;
//! - only on the target → `targetOnly` (deleted in Mirror, kept in Update);
//! - a file on one side and a folder on the other → `typeMismatch`:
//!   reported, never touched, and nothing under it is looked at;
//! - excluded by name pattern, or hidden with "skip hidden" → `excluded`;
//! - unsafe names, folder links, broken links, sockets/devices, files over
//!   the size cap → `skipped` with the reason.
//!
//! Excluded, skipped and mismatched paths **block** their subtree: nothing
//! under them is copied or deleted. A target-only folder is deleted as a
//! whole only when nothing under it was blocked (an excluded `.git` inside
//! keeps the folder; its other contents are deleted one by one).

use std::collections::{BTreeMap, HashSet};

use crate::fs::is_dotfile;
use crate::transfer::naming::is_safe_name;
use crate::transfer::UNSAFE_NAME;

use super::exclude::first_match;
use super::{CompareRule, SyncGroup, SyncItem, SyncItemKind, SyncMode, SyncTotals};

/// Modification times this close (in seconds) count as equal. SFTP carries
/// whole seconds and FAT/SMB keep two-second steps, so a copy made by
/// another tool can be up to two seconds off without being different.
pub const MTIME_TOLERANCE_SECS: i64 = 2;

/// One entry of a walked tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    /// The path below the synced folder, one name per segment.
    pub segments: Vec<String>,
    pub node: Node,
    /// A dotfile, or hidden by the OS.
    pub hidden: bool,
}

/// What a [`Listed`] entry is, for the comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A file, or a link to one (with the file's size and date).
    File {
        size: u64,
        mtime: Option<i64>,
    },
    Dir,
    /// Something a sync does not copy, with the reason.
    Unsupported(String),
}

/// The choices that steer the comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRules {
    pub mode: SyncMode,
    pub rule: CompareRule,
    /// A target file newer than the source (beyond the tolerance) is
    /// `targetNewer` instead of being overwritten. Implied by `newerOnly`.
    pub protect_newer: bool,
    /// Dotfiles (and OS-hidden entries) on both sides are left alone.
    pub skip_hidden: bool,
    /// Source files larger than this many MB are skipped.
    pub max_file_size_mb: Option<u64>,
    /// Name patterns (per segment) a sync never touches.
    pub excludes: Vec<String>,
}

/// What [`diff`] found: the listed items (in path order, folders before
/// their contents; `same` files are only counted) and the totals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub items: Vec<SyncItem>,
    pub totals: SyncTotals,
}

const MB: u64 = 1024 * 1024;

/// Compare `source` with `target` under `rules`.
pub fn diff(source: &[Listed], target: &[Listed], rules: &DiffRules) -> Diff {
    let mut pairs: BTreeMap<&[String], (Option<&Listed>, Option<&Listed>)> = BTreeMap::new();
    for entry in source {
        pairs.entry(&entry.segments).or_default().0 = Some(entry);
    }
    for entry in target {
        pairs.entry(&entry.segments).or_default().1 = Some(entry);
    }

    let mut items = Vec::new();
    let mut totals = SyncTotals::default();
    let mut blocked: HashSet<&[String]> = HashSet::new();
    for (segments, (src, dst)) in pairs {
        if segments.is_empty() || (1..segments.len()).any(|n| blocked.contains(&segments[..n])) {
            continue;
        }
        let item = classify(segments, src, dst, rules);
        // A file on the source can be a folder on the target: block by
        // group, whatever the kind.
        if matches!(
            item.group,
            SyncGroup::Excluded | SyncGroup::TypeMismatch | SyncGroup::Skipped
        ) {
            blocked.insert(segments);
        }
        totals.add(&item);
        if item.group != SyncGroup::Same {
            items.push(item);
        }
    }

    // A target-only folder with something blocked inside cannot go as a
    // whole: what is blocked must stay.
    let mut kept: HashSet<&[String]> = HashSet::new();
    for item in &items {
        if matches!(item.group, SyncGroup::Excluded | SyncGroup::Skipped) {
            for n in 1..item.segments.len() {
                kept.insert(&item.segments[..n]);
            }
        }
    }
    let whole: Vec<bool> = items
        .iter()
        .map(|item| {
            item.group == SyncGroup::TargetOnly
                && item.kind == SyncItemKind::Dir
                && !kept.contains(item.segments.as_slice())
        })
        .collect();
    for (item, whole) in items.iter_mut().zip(whole) {
        item.whole = whole;
    }
    Diff { items, totals }
}

fn classify(
    segments: &[String],
    src: Option<&Listed>,
    dst: Option<&Listed>,
    rules: &DiffRules,
) -> SyncItem {
    let name = segments.last().map(String::as_str).unwrap_or_default();
    let mut item = SyncItem::new(segments, src, dst);
    let skip = |mut item: SyncItem, group, reason: String| {
        item.group = group;
        item.reason = Some(reason);
        item
    };

    if !is_safe_name(name) {
        return skip(item, SyncGroup::Skipped, UNSAFE_NAME.into());
    }
    if let Some(pattern) = first_match(&rules.excludes, name) {
        return skip(item, SyncGroup::Excluded, format!("matches “{pattern}”"));
    }
    let hidden = is_dotfile(name) || src.is_some_and(|e| e.hidden) || dst.is_some_and(|e| e.hidden);
    if rules.skip_hidden && hidden {
        return skip(item, SyncGroup::Excluded, "hidden".into());
    }
    if let Some(Listed {
        node: Node::Unsupported(why),
        ..
    }) = src
    {
        return skip(item, SyncGroup::Skipped, why.clone());
    }
    if let Some(Listed {
        node: Node::Unsupported(why),
        ..
    }) = dst
    {
        return skip(item, SyncGroup::Skipped, format!("on the target: {why}"));
    }

    let too_large = |size: u64| rules.max_file_size_mb.is_some_and(|mb| size > mb * MB);
    let src_node = src.map(|e| &e.node);
    let dst_node = dst.map(|e| &e.node);
    item.group = match (src_node, dst_node) {
        (Some(Node::File { size, .. }), _) if too_large(*size) => {
            let mb = rules.max_file_size_mb.unwrap_or_default();
            return skip(item, SyncGroup::Skipped, format!("larger than {mb} MB"));
        }
        (Some(Node::File { .. } | Node::Dir), None) => SyncGroup::New,
        (None, Some(Node::File { .. } | Node::Dir)) => SyncGroup::TargetOnly,
        (Some(Node::Dir), Some(Node::Dir)) => SyncGroup::Same,
        (
            Some(Node::File {
                size: s_size,
                mtime: s_mtime,
            }),
            Some(Node::File {
                size: t_size,
                mtime: t_mtime,
            }),
        ) => compare(
            (*s_size, *s_mtime),
            (*t_size, *t_mtime),
            rules.rule,
            rules.protect_newer,
        ),
        (Some(Node::Dir), Some(Node::File { .. })) => {
            return skip(
                item,
                SyncGroup::TypeMismatch,
                "a folder on the source, a file on the target".into(),
            );
        }
        (Some(Node::File { .. }), Some(Node::Dir)) => {
            return skip(
                item,
                SyncGroup::TypeMismatch,
                "a file on the source, a folder on the target".into(),
            );
        }
        // Handled above, or not listed at all.
        _ => SyncGroup::Same,
    };
    item.selected = match item.group {
        SyncGroup::New | SyncGroup::Changed => true,
        SyncGroup::TargetOnly => rules.mode == SyncMode::Mirror,
        _ => false,
    };
    item
}

/// One file on both sides, `(size, mtime)` each, under `rule`.
fn compare(
    (s_size, s_mtime): (u64, Option<i64>),
    (t_size, t_mtime): (u64, Option<i64>),
    rule: CompareRule,
    protect_newer: bool,
) -> SyncGroup {
    // An unknown date never counts as newer or older: only the size can
    // tell then.
    let delta = s_mtime.zip(t_mtime).map(|(s, t)| s - t).unwrap_or(0);
    let src_newer = delta > MTIME_TOLERANCE_SECS;
    let dst_newer = delta < -MTIME_TOLERANCE_SECS;
    let size_differs = s_size != t_size;
    let protected = |group| {
        if protect_newer && dst_newer {
            SyncGroup::TargetNewer
        } else {
            group
        }
    };
    match rule {
        CompareRule::SizeOrDate if size_differs || src_newer || dst_newer => {
            protected(SyncGroup::Changed)
        }
        CompareRule::SizeOrDate => SyncGroup::Same,
        CompareRule::NewerOnly if src_newer => SyncGroup::Changed,
        CompareRule::NewerOnly if dst_newer => SyncGroup::TargetNewer,
        CompareRule::NewerOnly if size_differs => SyncGroup::DifferentSizeSameDate,
        CompareRule::NewerOnly => SyncGroup::Same,
        CompareRule::SizeOnly if size_differs => protected(SyncGroup::Changed),
        CompareRule::SizeOnly => SyncGroup::Same,
        CompareRule::Everything => protected(SyncGroup::Changed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(path: &str) -> Vec<String> {
        path.split('/').map(String::from).collect()
    }

    fn file(path: &str, size: u64, mtime: i64) -> Listed {
        Listed {
            segments: segs(path),
            node: Node::File {
                size,
                mtime: Some(mtime),
            },
            hidden: false,
        }
    }

    fn dir(path: &str) -> Listed {
        Listed {
            segments: segs(path),
            node: Node::Dir,
            hidden: false,
        }
    }

    fn odd(path: &str, why: &str) -> Listed {
        Listed {
            segments: segs(path),
            node: Node::Unsupported(why.into()),
            hidden: false,
        }
    }

    fn rules() -> DiffRules {
        DiffRules {
            mode: SyncMode::Update,
            rule: CompareRule::SizeOrDate,
            protect_newer: true,
            skip_hidden: false,
            max_file_size_mb: None,
            excludes: Vec::new(),
        }
    }

    fn mirror() -> DiffRules {
        DiffRules {
            mode: SyncMode::Mirror,
            ..rules()
        }
    }

    /// `(path, group)` of every listed item.
    fn groups(diff: &Diff) -> Vec<(String, SyncGroup)> {
        diff.items
            .iter()
            .map(|i| (i.path.clone(), i.group))
            .collect()
    }

    fn group_of(diff: &Diff, path: &str) -> SyncGroup {
        diff.items
            .iter()
            .find(|i| i.path == path)
            .map(|i| i.group)
            .unwrap_or(SyncGroup::Same)
    }

    fn item<'a>(diff: &'a Diff, path: &str) -> &'a SyncItem {
        diff.items
            .iter()
            .find(|i| i.path == path)
            .unwrap_or_else(|| panic!("no item {path}: {:#?}", diff.items))
    }

    const T: i64 = 1_700_000_000;

    /// The group one file pair lands in.
    fn pair(src: (u64, i64), dst: (u64, i64), rules: &DiffRules) -> SyncGroup {
        let d = diff(
            &[file("a", src.0, src.1)],
            &[file("a", dst.0, dst.1)],
            rules,
        );
        group_of(&d, "a")
    }

    fn with_rule(rule: CompareRule, protect_newer: bool) -> DiffRules {
        DiffRules {
            rule,
            protect_newer,
            ..rules()
        }
    }

    #[test]
    fn new_changed_same_and_target_only() {
        let src = [
            file("new.txt", 1, T),
            file("changed.txt", 2, T),
            file("same.txt", 3, T),
        ];
        let dst = [
            file("changed.txt", 9, T),
            file("same.txt", 3, T),
            file("old.txt", 4, T),
        ];
        let d = diff(&src, &dst, &rules());
        assert_eq!(
            groups(&d),
            vec![
                ("changed.txt".into(), SyncGroup::Changed),
                ("new.txt".into(), SyncGroup::New),
                ("old.txt".into(), SyncGroup::TargetOnly),
            ]
        );
        assert_eq!(d.totals.get(SyncGroup::Same).files, 1);
        assert_eq!(d.totals.get(SyncGroup::Same).bytes, 3);
        assert_eq!(d.totals.get(SyncGroup::New).bytes, 1);
        // Changed counts the source bytes (what is copied).
        assert_eq!(d.totals.get(SyncGroup::Changed).bytes, 2);
        assert_eq!(d.totals.get(SyncGroup::TargetOnly).bytes, 4);
        let changed = item(&d, "changed.txt");
        assert_eq!((changed.src_size, changed.dst_size), (Some(2), Some(9)));
    }

    #[test]
    fn update_keeps_target_only_items_and_mirror_selects_them() {
        let dst = [file("old.txt", 4, T)];
        let d = diff(&[], &dst, &rules());
        assert!(!item(&d, "old.txt").selected);
        let d = diff(&[], &dst, &mirror());
        assert!(item(&d, "old.txt").selected);
    }

    #[test]
    fn the_mtime_tolerance_is_two_seconds_either_way() {
        let r = rules();
        assert_eq!(pair((5, T + 2), (5, T), &r), SyncGroup::Same);
        assert_eq!(pair((5, T + 3), (5, T), &r), SyncGroup::Changed);
        assert_eq!(pair((5, T - 2), (5, T), &r), SyncGroup::Same);
        // Older source beyond the tolerance: the target is newer.
        assert_eq!(pair((5, T - 3), (5, T), &r), SyncGroup::TargetNewer);
        let unprotected = with_rule(CompareRule::SizeOrDate, false);
        assert_eq!(pair((5, T - 3), (5, T), &unprotected), SyncGroup::Changed);
    }

    #[test]
    fn an_unknown_date_leaves_only_the_size_to_compare() {
        let src = Listed {
            node: Node::File {
                size: 5,
                mtime: None,
            },
            ..file("a", 0, 0)
        };
        let d = diff(std::slice::from_ref(&src), &[file("a", 5, T)], &rules());
        assert_eq!(group_of(&d, "a"), SyncGroup::Same);
        let d = diff(&[src], &[file("a", 6, T)], &rules());
        assert_eq!(group_of(&d, "a"), SyncGroup::Changed);
    }

    #[test]
    fn newer_only_copies_newer_sources_and_flags_size_only_changes() {
        let r = with_rule(CompareRule::NewerOnly, false);
        assert_eq!(pair((5, T + 3), (5, T), &r), SyncGroup::Changed);
        assert_eq!(pair((5, T + 2), (5, T), &r), SyncGroup::Same);
        assert_eq!(pair((5, T - 3), (5, T), &r), SyncGroup::TargetNewer);
        assert_eq!(
            pair((6, T + 1), (5, T), &r),
            SyncGroup::DifferentSizeSameDate
        );
        assert_eq!(pair((6, T - 3), (5, T), &r), SyncGroup::TargetNewer);
        let d = diff(&[file("a", 6, T)], &[file("a", 5, T)], &r);
        assert!(!item(&d, "a").selected, "unticked by default");
    }

    #[test]
    fn size_only_ignores_dates() {
        let r = with_rule(CompareRule::SizeOnly, true);
        assert_eq!(pair((5, T + 100), (5, T), &r), SyncGroup::Same);
        assert_eq!(pair((5, T - 100), (5, T), &r), SyncGroup::Same);
        assert_eq!(pair((6, T), (5, T), &r), SyncGroup::Changed);
        assert_eq!(pair((6, T - 3), (5, T), &r), SyncGroup::TargetNewer);
        let r = with_rule(CompareRule::SizeOnly, false);
        assert_eq!(pair((6, T - 3), (5, T), &r), SyncGroup::Changed);
    }

    #[test]
    fn everything_copies_identical_files_too_unless_the_target_is_newer() {
        let r = with_rule(CompareRule::Everything, true);
        assert_eq!(pair((5, T), (5, T), &r), SyncGroup::Changed);
        assert_eq!(pair((5, T - 2), (5, T), &r), SyncGroup::Changed);
        assert_eq!(pair((5, T - 3), (5, T), &r), SyncGroup::TargetNewer);
        let r = with_rule(CompareRule::Everything, false);
        assert_eq!(pair((5, T - 3), (5, T), &r), SyncGroup::Changed);
    }

    #[test]
    fn target_newer_is_listed_unticked() {
        let d = diff(&[file("a", 5, T - 10)], &[file("a", 5, T)], &rules());
        let a = item(&d, "a");
        assert_eq!(a.group, SyncGroup::TargetNewer);
        assert!(!a.selected);
        assert_eq!((a.src_mtime, a.dst_mtime), (Some(T - 10), Some(T)));
    }

    #[test]
    fn new_files_are_copied_under_every_rule() {
        for rule in [
            CompareRule::SizeOrDate,
            CompareRule::NewerOnly,
            CompareRule::SizeOnly,
            CompareRule::Everything,
        ] {
            let d = diff(&[file("a", 1, T)], &[], &with_rule(rule, true));
            assert_eq!(group_of(&d, "a"), SyncGroup::New, "{rule:?}");
            assert!(item(&d, "a").selected);
        }
    }

    #[test]
    fn nested_folders_match_by_relative_path() {
        let src = [
            dir("docs"),
            file("docs/a.txt", 1, T),
            dir("docs/img"),
            file("docs/img/b.png", 2, T),
            dir("fresh"),
            file("fresh/c.txt", 3, T),
        ];
        let dst = [
            dir("docs"),
            file("docs/a.txt", 1, T),
            dir("docs/img"),
            dir("stale"),
            file("stale/d.txt", 4, T),
        ];
        let d = diff(&src, &dst, &mirror());
        assert_eq!(
            groups(&d),
            vec![
                ("docs/img/b.png".into(), SyncGroup::New),
                ("fresh".into(), SyncGroup::New),
                ("fresh/c.txt".into(), SyncGroup::New),
                ("stale".into(), SyncGroup::TargetOnly),
                ("stale/d.txt".into(), SyncGroup::TargetOnly),
            ]
        );
        assert_eq!(item(&d, "fresh").kind, SyncItemKind::Dir);
        assert!(item(&d, "stale").whole);
        assert_eq!(d.totals.get(SyncGroup::New).dirs, 1);
        assert_eq!(d.totals.get(SyncGroup::New).files, 2);
        assert_eq!(d.totals.get(SyncGroup::Same).files, 1);
    }

    #[test]
    fn type_mismatches_are_reported_and_their_contents_ignored() {
        let src = [dir("a"), file("a/inner.txt", 1, T), file("b", 1, T)];
        let dst = [file("a", 1, T), dir("b"), file("b/x.txt", 1, T)];
        let d = diff(&src, &dst, &mirror());
        assert_eq!(
            groups(&d),
            vec![
                ("a".into(), SyncGroup::TypeMismatch),
                ("b".into(), SyncGroup::TypeMismatch),
            ]
        );
        assert!(!item(&d, "a").selected);
        assert!(item(&d, "b").reason.is_some());
    }

    #[test]
    fn excludes_match_any_segment_and_block_their_subtree() {
        let r = DiffRules {
            excludes: vec!["node_modules".into(), "*.log".into()],
            ..mirror()
        };
        let src = [
            dir("app"),
            dir("app/node_modules"),
            file("app/node_modules/x.js", 1, T),
            file("app/run.log", 2, T),
            file("app/main.js", 3, T),
        ];
        let dst = [
            dir("app"),
            file("app/debug.log", 4, T),
            dir("node_modules"),
            file("node_modules/y.js", 5, T),
        ];
        let d = diff(&src, &dst, &r);
        assert_eq!(
            groups(&d),
            vec![
                ("app/debug.log".into(), SyncGroup::Excluded),
                ("app/main.js".into(), SyncGroup::New),
                ("app/node_modules".into(), SyncGroup::Excluded),
                ("app/run.log".into(), SyncGroup::Excluded),
                ("node_modules".into(), SyncGroup::Excluded),
            ]
        );
        assert_eq!(
            item(&d, "app/run.log").reason.as_deref(),
            Some("matches “*.log”")
        );
        assert_eq!(d.totals.get(SyncGroup::Excluded).files, 2);
        assert_eq!(d.totals.get(SyncGroup::Excluded).dirs, 2);
    }

    #[test]
    fn a_target_only_folder_with_an_excluded_entry_is_not_deleted_whole() {
        let r = DiffRules {
            excludes: vec![".git".into()],
            ..mirror()
        };
        let dst = [
            dir("old"),
            dir("old/.git"),
            file("old/readme.txt", 1, T),
            dir("gone"),
            file("gone/a.txt", 1, T),
        ];
        let d = diff(&[], &dst, &r);
        assert!(!item(&d, "old").whole);
        assert!(item(&d, "old/readme.txt").selected);
        assert!(item(&d, "gone").whole);
    }

    #[test]
    fn hidden_entries_are_left_alone_when_skipped() {
        let r = DiffRules {
            skip_hidden: true,
            ..mirror()
        };
        let src = [file(".env", 1, T), dir(".config"), file(".config/a", 1, T)];
        let dst = [
            file(".secret", 2, T),
            dir("keep"),
            file("keep/.hidden", 1, T),
            Listed {
                hidden: true,
                ..file("keep/win-hidden.txt", 1, T)
            },
        ];
        let d = diff(&src, &dst, &r);
        assert_eq!(
            groups(&d),
            vec![
                (".config".into(), SyncGroup::Excluded),
                (".env".into(), SyncGroup::Excluded),
                (".secret".into(), SyncGroup::Excluded),
                ("keep".into(), SyncGroup::TargetOnly),
                ("keep/.hidden".into(), SyncGroup::Excluded),
                ("keep/win-hidden.txt".into(), SyncGroup::Excluded),
            ]
        );
        // A hidden target-only file is never deleted in Mirror, and keeps
        // its folder.
        assert!(!item(&d, ".secret").selected);
        assert!(!item(&d, "keep").whole);

        // Without the option they are synced like anything else.
        let d = diff(&src, &dst, &mirror());
        assert_eq!(group_of(&d, ".env"), SyncGroup::New);
        assert_eq!(group_of(&d, ".secret"), SyncGroup::TargetOnly);
        assert!(item(&d, "keep").whole);
    }

    #[test]
    fn files_over_the_size_cap_are_skipped_with_the_reason() {
        let r = DiffRules {
            max_file_size_mb: Some(1),
            ..rules()
        };
        let src = [
            file("big.bin", MB + 1, T),
            file("edge.bin", MB, T),
            file("big-changed.bin", 2 * MB, T),
        ];
        let dst = [file("big-changed.bin", 1, T)];
        let d = diff(&src, &dst, &r);
        let big = item(&d, "big.bin");
        assert_eq!(big.group, SyncGroup::Skipped);
        assert_eq!(big.reason.as_deref(), Some("larger than 1 MB"));
        assert!(!big.selected);
        assert_eq!(group_of(&d, "edge.bin"), SyncGroup::New);
        assert_eq!(group_of(&d, "big-changed.bin"), SyncGroup::Skipped);
    }

    #[test]
    fn unsupported_entries_and_unsafe_names_are_skipped() {
        let src = [
            odd("link-to-dir", "links to folders are not copied"),
            file("..", 1, T),
        ];
        let dst = [odd("socket", "only files and folders are copied")];
        let d = diff(&src, &dst, &mirror());
        assert_eq!(group_of(&d, "link-to-dir"), SyncGroup::Skipped);
        assert_eq!(group_of(&d, ".."), SyncGroup::Skipped);
        // A segment with a separator in it (as a server could list it).
        let weird = Listed {
            segments: vec!["we/ird".into()],
            ..file("x", 1, T)
        };
        let d2 = diff(&[weird], &[], &rules());
        assert_eq!(d2.items[0].group, SyncGroup::Skipped);
        assert_eq!(
            item(&d, "socket").reason.as_deref(),
            Some("on the target: only files and folders are copied")
        );
        // Never deleted, even in Mirror.
        assert!(!item(&d, "socket").selected);
    }
}
