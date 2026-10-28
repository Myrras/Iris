//! Progress bookkeeping: an event throttle and a moving-window speed.
//!
//! Both take the current [`Instant`] as an argument instead of reading the
//! clock, so tests drive them with a fake one.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// At most this often per job is a `TransferProgress` event published
/// (≤ 10 per second).
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// How far back the transfer speed looks.
pub(crate) const SPEED_WINDOW: Duration = Duration::from_secs(3);

/// The shortest span a speed is averaged over, so the first chunk of a
/// fresh transfer does not read as an absurd rate.
const MIN_SPAN: Duration = Duration::from_millis(250);

/// Lets one event through per `interval`.
#[derive(Debug)]
pub(crate) struct Throttle {
    interval: Duration,
    last: Option<Instant>,
}

impl Throttle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    /// Whether an event may go out at `now`; if so, `now` starts the next
    /// interval.
    pub fn ready(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.saturating_duration_since(last) < self.interval => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

/// Bytes per second over the last [`SPEED_WINDOW`].
#[derive(Debug)]
pub(crate) struct SpeedMeter {
    started: Option<Instant>,
    samples: VecDeque<(Instant, u64)>,
    in_window: u64,
}

impl SpeedMeter {
    pub fn new() -> Self {
        Self {
            started: None,
            samples: VecDeque::new(),
            in_window: 0,
        }
    }

    /// `bytes` were copied at `now`.
    pub fn record(&mut self, now: Instant, bytes: u64) {
        self.started.get_or_insert(now);
        self.samples.push_back((now, bytes));
        self.in_window += bytes;
        self.prune(now);
    }

    /// The average rate over the window (or over the time since the first
    /// sample, when that is shorter).
    pub fn rate(&mut self, now: Instant) -> u64 {
        self.prune(now);
        let Some(started) = self.started else {
            return 0;
        };
        let span = now
            .saturating_duration_since(started)
            .clamp(MIN_SPAN, SPEED_WINDOW);
        (self.in_window as f64 / span.as_secs_f64()) as u64
    }

    fn prune(&mut self, now: Instant) {
        while let Some(&(at, bytes)) = self.samples.front() {
            if now.saturating_duration_since(at) <= SPEED_WINDOW {
                break;
            }
            self.samples.pop_front();
            self.in_window -= bytes;
        }
    }
}

impl Default for SpeedMeter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn the_throttle_lets_at_most_ten_events_a_second_through() {
        let start = Instant::now();
        let mut throttle = Throttle::new(PROGRESS_INTERVAL);
        // A chunk every millisecond for two seconds.
        let passed = (0..2000)
            .filter(|i| throttle.ready(start + MS * *i))
            .count();
        assert_eq!(passed, 20);
    }

    #[test]
    fn the_first_event_always_passes() {
        let mut throttle = Throttle::new(PROGRESS_INTERVAL);
        let now = Instant::now();
        assert!(throttle.ready(now));
        assert!(!throttle.ready(now + 99 * MS));
        assert!(throttle.ready(now + 100 * MS));
    }

    #[test]
    fn speed_averages_over_the_window() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new();
        // 100 KiB every 100 ms = 1000 KiB/s.
        for i in 0..50 {
            meter.record(start + 100 * MS * i, 100 * 1024);
        }
        let rate = meter.rate(start + 100 * MS * 49);
        assert!((990_000..=1_060_000).contains(&rate), "{rate}");
    }

    #[test]
    fn speed_decays_to_zero_when_idle() {
        let start = Instant::now();
        let mut meter = SpeedMeter::new();
        meter.record(start, 1_000_000);
        assert!(meter.rate(start + 500 * MS) > 0);
        assert_eq!(meter.rate(start + SPEED_WINDOW + 500 * MS), 0);
    }

    #[test]
    fn an_empty_meter_reads_zero() {
        assert_eq!(SpeedMeter::new().rate(Instant::now()), 0);
    }
}
