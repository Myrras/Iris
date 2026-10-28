//! The transfer list as a CSV file, to look at later (a spreadsheet, a
//! report).
//!
//! ## Format
//! RFC 4180: one header row, then one row per job in list order; fields
//! separated by `,`, **every field quoted** (`"` doubled inside), rows
//! ended by CRLF, so names with commas, quotes or line breaks survive. The
//! file is UTF-8 with a byte order mark, which Excel needs to read it as
//! UTF-8 (other tools skip it). A comma — not the `;` some European Excel
//! versions expect — because it is the RFC's separator; quoting everything
//! keeps a `;`-reading Excel from splitting names, and its import dialog
//! takes `,`.
//!
//! A text field that starts with `=`, `+`, `-`, `@`, a tab or a carriage
//! return gets a leading `'`: spreadsheets would otherwise run it as a
//! formula, and file names come from the server.
//!
//! Columns: see [`COLUMNS`]. Times are ISO 8601 in local time with the
//! offset (`2026-10-16T14:03:12+02:00`); `duration_secs` is wall-clock time
//! from the first start to the end (a wait for a conflict answer or a
//! reconnect included), `average_bytes_per_sec` the bytes copied over that
//! time. The connection columns carry the saved connection's name and host,
//! never a user name, password or key. Only what is in the list is
//! exported: "Clear finished" removes jobs from it.

use std::path::Path;

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::persist::write_bytes_atomic;
use crate::transfer::{TransferDirection, TransferJob, TransferState};
use crate::Core;

/// The header row, in order.
pub const COLUMNS: [&str; 16] = [
    "batch_id",
    "job_id",
    "direction",
    "connection",
    "host",
    "source",
    "destination",
    "size_bytes",
    "bytes_done",
    "state",
    "error_kind",
    "error_message",
    "started_at",
    "finished_at",
    "duration_secs",
    "average_bytes_per_sec",
];

/// Which jobs `export_transfers_csv` writes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportScope {
    /// Every job in the list.
    #[default]
    All,
    /// Only done, failed, cancelled and skipped jobs.
    Finished,
}

/// What `export_transfers_csv` wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    /// Jobs written (the header not counted).
    pub rows: usize,
}

/// The saved connection a job ran on, as the CSV shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Connection {
    pub name: String,
    pub host: String,
}

const BOM: &str = "\u{feff}";

impl Core {
    /// Write the transfer list (see the module docs for the format) to the
    /// local file `path`, replacing it atomically. `InvalidInput` for a
    /// path that is empty or not absolute, `NotFound` when its folder does
    /// not exist, `Io` / `PermissionDenied` when it cannot be written.
    pub fn export_transfers_csv(&self, path: &str, scope: ExportScope) -> CoreResult<ExportReport> {
        let target = Path::new(path);
        if path.trim().is_empty() || !target.is_absolute() {
            return Err(CoreError::InvalidInput(
                "choose where to save the CSV file".into(),
            ));
        }
        let rows = self
            .inner
            .transfers
            .export_rows(scope == ExportScope::Finished);
        let profiles = self.list_profiles();
        let rows: Vec<(TransferJob, Connection)> = rows
            .into_iter()
            .map(|(job, profile)| {
                let connection = profile
                    .and_then(|id| profiles.iter().find(|p| p.id == id))
                    .map(|p| Connection {
                        name: p.name.clone(),
                        host: if p.port == 22 {
                            p.host.clone()
                        } else {
                            format!("{}:{}", p.host, p.port)
                        },
                    })
                    .unwrap_or_default();
                (job, connection)
            })
            .collect();
        let csv = to_csv(&rows, &Local);
        write_bytes_atomic(target, csv.as_bytes())?;
        tracing::info!(rows = rows.len(), "transfers exported");
        Ok(ExportReport {
            path: path.to_string(),
            rows: rows.len(),
        })
    }
}

/// The whole file, BOM included. `zone` formats the times (local time in
/// the app, a fixed offset in tests).
pub(crate) fn to_csv<Tz: TimeZone>(rows: &[(TransferJob, Connection)], zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let mut out = String::from(BOM);
    push_row(&mut out, COLUMNS.iter().map(|c| c.to_string()));
    for (job, connection) in rows {
        push_row(&mut out, fields(job, connection, zone));
    }
    out
}

fn fields<Tz: TimeZone>(job: &TransferJob, connection: &Connection, zone: &Tz) -> Vec<String>
where
    Tz::Offset: std::fmt::Display,
{
    let time = |ms: Option<i64>| {
        ms.and_then(|ms| zone.timestamp_millis_opt(ms).single())
            .map(|t| t.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
            .unwrap_or_default()
    };
    let span_ms = match (job.started_at, job.finished_at) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    };
    let duration = span_ms
        .map(|ms| format!("{:.3}", ms as f64 / 1000.0))
        .unwrap_or_default();
    let speed = span_ms
        .filter(|ms| *ms > 0)
        .map(|ms| ((job.bytes_done as f64) * 1000.0 / ms as f64).round() as u64)
        .map(|v| v.to_string())
        .unwrap_or_default();
    let (error_kind, error_message) = job
        .error
        .as_ref()
        .map(|e| (e.kind.clone(), e.message.clone()))
        .unwrap_or_default();
    vec![
        job.batch_id.to_string(),
        job.id.to_string(),
        direction(job.direction).into(),
        text(&connection.name),
        text(&connection.host),
        text(&job.src),
        text(&job.dst),
        job.size.to_string(),
        job.bytes_done.to_string(),
        state(job.state).into(),
        error_kind,
        text(&error_message),
        time(job.started_at),
        time(job.finished_at),
        duration,
        speed,
    ]
}

/// A text field a spreadsheet must not run as a formula.
fn text(value: &str) -> String {
    match value.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{value}"),
        _ => value.to_string(),
    }
}

fn push_row(out: &mut String, fields: impl IntoIterator<Item = String>) {
    for (i, field) in fields.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&field.replace('"', "\"\""));
        out.push('"');
    }
    out.push_str("\r\n");
}

fn direction(direction: TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    }
}

/// The state as on the wire.
fn state(state: TransferState) -> &'static str {
    match state {
        TransferState::Queued => "queued",
        TransferState::Running => "running",
        TransferState::NeedsDecision => "needsDecision",
        TransferState::Paused => "paused",
        TransferState::Done => "done",
        TransferState::Failed => "failed",
        TransferState::Cancelled => "cancelled",
        TransferState::Skipped => "skipped",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{BatchId, SessionId, TransferId};
    use crate::transfer::TransferError;
    use chrono::FixedOffset;

    fn job(src: &str) -> TransferJob {
        TransferJob {
            id: TransferId::new(),
            batch_id: BatchId::new(),
            session_id: SessionId::new(),
            direction: TransferDirection::Download,
            src: src.into(),
            dst: "/home/demo/out.txt".into(),
            size: 2_000_000,
            bytes_done: 2_000_000,
            state: TransferState::Done,
            error: None,
            folder: false,
            // 2026-10-16T12:00:00Z, then 4 s later.
            started_at: Some(1_792_152_000_000),
            finished_at: Some(1_792_152_004_000),
        }
    }

    fn connection() -> Connection {
        Connection {
            name: "Demo server".into(),
            host: "sftp.example.test:2222".into(),
        }
    }

    /// Split a CSV the way RFC 4180 reads it (quotes, doubled quotes,
    /// line breaks inside quotes).
    fn parse(csv: &str) -> Vec<Vec<String>> {
        let mut rows = vec![];
        let mut row = vec![];
        let mut field = String::new();
        let mut quoted = false;
        let mut chars = csv.chars().peekable();
        while let Some(c) = chars.next() {
            match (c, quoted) {
                ('"', true) if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                ('"', _) => quoted = !quoted,
                (',', false) => row.push(std::mem::take(&mut field)),
                ('\r', false) => {}
                ('\n', false) => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                (c, _) => field.push(c),
            }
        }
        rows
    }

    #[test]
    fn starts_with_a_bom_and_the_header_in_order() {
        let csv = to_csv(&[], &FixedOffset::east_opt(0).unwrap());
        assert!(csv.starts_with('\u{feff}'));
        let rows = parse(&csv['\u{feff}'.len_utf8()..]);
        assert_eq!(rows, vec![COLUMNS.map(String::from).to_vec()]);
        assert!(csv.ends_with("\"\r\n"), "CRLF rows");
    }

    #[test]
    fn every_field_is_quoted_and_survives_commas_quotes_newlines_and_unicode() {
        let odd = "/srv/räpport, \"final\"\nv2 — 日本.txt";
        let rows = vec![(job(odd), connection())];
        let csv = to_csv(&rows, &FixedOffset::east_opt(2 * 3600).unwrap());
        let body = &csv['\u{feff}'.len_utf8()..];
        // Each field quoted: the header line is all quoted names.
        assert!(body.starts_with("\"batch_id\",\"job_id\","));
        let parsed = parse(body);
        assert_eq!(parsed.len(), 2);
        let row = &parsed[1];
        assert_eq!(row.len(), COLUMNS.len());
        let col = |name: &str| &row[COLUMNS.iter().position(|c| *c == name).unwrap()];
        assert_eq!(col("source"), odd);
        assert_eq!(col("connection"), "Demo server");
        assert_eq!(col("host"), "sftp.example.test:2222");
        assert_eq!(col("direction"), "download");
        assert_eq!(col("state"), "done");
        assert_eq!(col("size_bytes"), "2000000");
        assert_eq!(col("started_at"), "2026-10-16T14:00:00+02:00");
        assert_eq!(col("finished_at"), "2026-10-16T14:00:04+02:00");
        assert_eq!(col("duration_secs"), "4.000");
        assert_eq!(col("average_bytes_per_sec"), "500000");
        assert_eq!(col("error_kind"), "");
    }

    #[test]
    fn unfinished_jobs_and_errors() {
        let mut failed = job("/srv/a.txt");
        failed.state = TransferState::Failed;
        failed.bytes_done = 10;
        failed.error = Some(TransferError {
            kind: "permissionDenied".into(),
            message: "permission denied: /home/demo".into(),
        });
        let mut queued = job("/srv/b.txt");
        queued.state = TransferState::Queued;
        queued.started_at = None;
        queued.finished_at = None;
        let rows = vec![(failed, connection()), (queued, Connection::default())];
        let parsed = parse(&to_csv(&rows, &FixedOffset::east_opt(0).unwrap())[3..]);
        let idx = |name: &str| COLUMNS.iter().position(|c| *c == name).unwrap();
        assert_eq!(parsed[1][idx("error_kind")], "permissionDenied");
        assert_eq!(
            parsed[1][idx("error_message")],
            "permission denied: /home/demo"
        );
        assert_eq!(parsed[2][idx("state")], "queued");
        assert_eq!(parsed[2][idx("started_at")], "");
        assert_eq!(parsed[2][idx("duration_secs")], "");
        assert_eq!(parsed[2][idx("average_bytes_per_sec")], "");
        assert_eq!(parsed[2][idx("connection")], "");
    }

    #[test]
    fn text_that_looks_like_a_formula_is_defused() {
        let rows = vec![(job("=HYPERLINK(\"http://x\")"), connection())];
        let parsed = parse(&to_csv(&rows, &FixedOffset::east_opt(0).unwrap())[3..]);
        let idx = COLUMNS.iter().position(|c| *c == "source").unwrap();
        assert_eq!(parsed[1][idx], "'=HYPERLINK(\"http://x\")");
        assert_eq!(text("-rf"), "'-rf");
        assert_eq!(text("@home"), "'@home");
        assert_eq!(text("/srv/a"), "/srv/a");
    }

    #[test]
    fn no_column_carries_a_secret() {
        for column in COLUMNS {
            for word in ["password", "passphrase", "secret", "key", "user"] {
                assert!(!column.contains(word), "{column}");
            }
        }
    }

    #[test]
    fn scope_parses_from_camel_case() {
        let all: ExportScope = serde_json::from_str("\"all\"").unwrap();
        let finished: ExportScope = serde_json::from_str("\"finished\"").unwrap();
        assert_eq!((all, finished), (ExportScope::All, ExportScope::Finished));
    }
}
