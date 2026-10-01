//! Watches the sharded node directory for external changes (docs/design.md,
//! "外部变更同步"). Non-recursive on purpose: recursive watching is
//! unavailable on Linux, so there is one watch on `nodes/` plus one per shard
//! directory — the watch count stays bounded by the shard count, and shard
//! directories are created lazily as ids are generated.
//!
//! The state machine is pure logic over an injected [`WatchSink`] (host
//! watches + timers) and [`Io`] (directory scans): hosts forward raw
//! filesystem events to [`WatcherCore::on_root_event`] /
//! [`WatcherCore::on_shard_event`], timer expiry to
//! [`WatcherCore::on_timer`], and receive debounced id batches back through
//! the batch callback. File events report the affected node id (shard name +
//! the id segment of the file name) plus the shard directory itself. Ids
//! cover everything that matches the node file shape; the shard names let the
//! index drop parse issues keyed by files that no longer exist (an ill-shaped
//! file is never reported as an id, so a rename or delete of one would
//! otherwise leave its load-phase issue stuck). A newly created shard is
//! scanned wholesale because its first files may predate the shard's own
//! watcher. Events are debounced: after a quiet period the accumulated ids
//! flush as one batch.
//!
//! Watch initialization fails permanently (e.g. the directory is missing)
//! with [`ArmResult::GiveUp`] — the server silently degrades to manual
//! refresh (POST /api/reload). Transient resource exhaustion (the
//! machine-wide per-user inotify instance budget) retries arming in the
//! background instead. Removing a whole shard directory is likewise not
//! reported per id and needs a manual reload.

use crate::io::{DirEntry, Io, WatchError};

/// The debounced batch callback: affected ids plus touched shards.
type BatchCallback = Box<dyn FnMut(&[String], &[String]) + Send>;

/// A shard directory name: the first 2 characters of a node id.
fn is_shard_name(name: &str) -> bool {
    name.len() == 2 && name.bytes().all(is_id_byte)
}

/// A node file name inside a shard: `<id_2>-<type>.md`, id_2 = id minus its
/// first 2 characters.
fn is_node_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    let Some(dash) = stem.rfind('-') else {
        return false;
    };
    let (id2, type_name) = (&stem[..dash], &stem[dash + 1..]);
    if id2.is_empty() || !id2.bytes().all(is_id_byte) {
        return false;
    }
    type_name == "premise" || type_name == "decision"
}

fn is_id_byte(b: u8) -> bool {
    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
}

/// Host side of the watcher: directory watches and the debounce/retry timers.
/// Timer kinds are separate slots; setting a kind again replaces its pending
/// tick.
pub trait WatchSink {
    /// Watch a directory; the error class decides the retry policy.
    fn watch_dir(&mut self, path: &std::path::Path) -> Result<(), WatchError>;
    fn unwatch_dir(&mut self, path: &std::path::Path);
    fn set_timer(&mut self, kind: TimerKind, delay_ms: u64);
    fn cancel_timer(&mut self, kind: TimerKind);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimerKind {
    /// Debounce timer coalescing file events into a batch.
    Debounce,
    /// Retry timer for transient arming failures.
    RetryArm,
}

/// Result of arming the watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArmResult {
    Armed,
    /// Transient exhaustion (EMFILE/ENOSPC): re-arm via
    /// [`WatcherCore::schedule_retry`]; the retry loop keeps trying every
    /// [`RETRY_ARM_DELAY_MS`] until it arms or hits a permanent failure. A
    /// late-armed watcher has missed every file event since open, so its
    /// arming runs with a catch-up scan over the current shards.
    Transient,
    /// Permanent failure (missing directory, watching unavailable).
    GiveUp,
}

/// Retry spacing for transient arming failures.
pub const RETRY_ARM_DELAY_MS: u64 = 250;

/// Default debounce quiet period.
pub const DEFAULT_DEBOUNCE_MS: u64 = 500;

pub struct WatcherCore {
    nodes_dir: std::path::PathBuf,
    debounce_ms: u64,
    watched_shards: Vec<String>,
    pending: Vec<String>,
    /// Shards touched by any file event, well-shaped or not.
    dirty_shards: Vec<String>,
    /// Shards needing a second scan: files may land between the first scan
    /// and the shard watcher attach.
    rescan_pending: Vec<String>,
    retry_scheduled: bool,
    closed: bool,
    on_batch: BatchCallback,
}

impl WatcherCore {
    /// Build a watcher core over `nodes_dir` with the given quiet period and
    /// batch callback.
    pub fn new(
        nodes_dir: std::path::PathBuf,
        debounce_ms: u64,
        on_batch: impl FnMut(&[String], &[String]) + Send + 'static,
    ) -> Self {
        WatcherCore {
            nodes_dir,
            debounce_ms: if debounce_ms == 0 {
                DEFAULT_DEBOUNCE_MS
            } else {
                debounce_ms
            },
            watched_shards: Vec::new(),
            pending: Vec::new(),
            dirty_shards: Vec::new(),
            rescan_pending: Vec::new(),
            retry_scheduled: false,
            closed: false,
            on_batch: Box::new(on_batch),
        }
    }

    /// Arm the root watch and one watch per existing shard. `catch_up` scans
    /// every current shard into the first batch — for watchers that armed
    /// late and so missed all earlier file events.
    pub fn arm(&mut self, sink: &mut dyn WatchSink, io: &dyn Io, catch_up: bool) -> ArmResult {
        if let Err(error) = sink.watch_dir(&self.nodes_dir) {
            return match error {
                WatchError::Transient => ArmResult::Transient,
                WatchError::Permanent => ArmResult::GiveUp,
            };
        }
        let entries = match io.read_dir(&self.nodes_dir) {
            Ok(entries) => entries,
            Err(_) => return ArmResult::GiveUp,
        };
        for entry in entries {
            if !entry.is_dir || !is_shard_name(&entry.name) {
                continue;
            }
            self.watch_shard(sink, &entry.name);
            if catch_up {
                self.scan_shard(io, &entry.name);
                self.mark_dirty(&entry.name);
                self.rescan_pending.push(entry.name.clone());
                self.schedule(sink);
            }
        }
        ArmResult::Armed
    }

    /// Start the transient-exhaustion retry loop. Sibling processes release
    /// their inotify instances as they exit, so re-arming can succeed later;
    /// a late-armed watcher needs the catch-up scan.
    pub fn schedule_retry(&mut self, sink: &mut dyn WatchSink) {
        if self.closed {
            return;
        }
        self.retry_scheduled = true;
        sink.set_timer(TimerKind::RetryArm, RETRY_ARM_DELAY_MS);
    }

    /// Retry-timer tick: re-arm with catch-up. Give up on permanent failures;
    /// keep retrying on transient ones.
    pub fn on_retry_tick(&mut self, sink: &mut dyn WatchSink, io: &dyn Io) {
        self.retry_scheduled = false;
        if self.closed {
            return;
        }
        match self.arm(sink, io, true) {
            ArmResult::Armed => {}
            ArmResult::Transient => self.schedule_retry(sink),
            ArmResult::GiveUp => {}
        }
    }

    /// A raw event on the root watch. `filename: None` (inotify queue
    /// overflow, or a platform that drops the name) reconciles the whole
    /// root: any number of events — including whole new shard directories —
    /// may have been lost.
    pub fn on_root_event(&mut self, filename: Option<&str>, sink: &mut dyn WatchSink, io: &dyn Io) {
        if self.closed {
            return;
        }
        let Some(name) = filename else {
            self.reconcile_root(sink, io);
            return;
        };
        if !is_shard_name(name) {
            return;
        }
        // A shard appearing gets a watcher, an immediate scan, and a deferred
        // second scan after the quiet period: its first files may be written
        // before inotify delivers the directory event, so neither the watcher
        // nor the immediate scan alone can see them. A shard disappearing
        // drops its watcher — the id-level deletions are covered by reload.
        self.watch_shard(sink, name);
        self.scan_shard(io, name);
        self.mark_dirty(name);
        if !self.rescan_pending.contains(&name.to_string()) {
            self.rescan_pending.push(name.to_string());
        }
        self.schedule(sink);
    }

    /// A raw event on a shard watch. `filename: None` (platform gave no name)
    /// rescans the shard. Temp files from atomic writes never match the node
    /// shape and are ignored.
    pub fn on_shard_event(
        &mut self,
        shard: &str,
        filename: Option<&str>,
        sink: &mut dyn WatchSink,
        io: &dyn Io,
    ) {
        if self.closed {
            return;
        }
        self.mark_dirty(shard);
        match filename {
            None => self.scan_shard(io, shard),
            Some(file) => {
                if is_node_file_name(file) {
                    let id = format!(
                        "{shard}{}",
                        &file[..file.rfind('-').expect("shape checked")]
                    );
                    self.queue(sink, id);
                }
            }
        }
    }

    /// Timer tick. The debounce tick applies deferred shard rescans (their
    /// ids flush after the next quiet period), then emits the accumulated
    /// batch; the retry tick re-arms after transient exhaustion.
    pub fn on_timer(&mut self, kind: TimerKind, sink: &mut dyn WatchSink, io: &dyn Io) {
        if self.closed {
            return;
        }
        match kind {
            TimerKind::RetryArm => self.on_retry_tick(sink, io),
            TimerKind::Debounce => {
                for name in std::mem::take(&mut self.rescan_pending) {
                    self.scan_shard(io, &name);
                }
                if self.pending.is_empty() && self.dirty_shards.is_empty() {
                    return;
                }
                let ids = std::mem::take(&mut self.pending);
                let dirty = std::mem::take(&mut self.dirty_shards);
                (self.on_batch)(&ids, &dirty);
            }
        }
    }

    /// Drop every watch; the core becomes inert.
    pub fn close(&mut self, sink: &mut dyn WatchSink) {
        self.closed = true;
        for name in &self.watched_shards {
            sink.unwatch_dir(&self.nodes_dir.join(name));
        }
        self.watched_shards.clear();
        sink.cancel_timer(TimerKind::Debounce);
        sink.cancel_timer(TimerKind::RetryArm);
        self.retry_scheduled = false;
        self.pending.clear();
        self.dirty_shards.clear();
        self.rescan_pending.clear();
    }

    fn watch_shard(&mut self, sink: &mut dyn WatchSink, name: &str) {
        if self.watched_shards.iter().any(|s| s == name) {
            return;
        }
        if sink.watch_dir(&self.nodes_dir.join(name)).is_err() {
            return; // e.g. removed again immediately; root events keep retrying
        }
        self.watched_shards.push(name.to_string());
    }

    /// List a shard directory and queue every node file found in it. A
    /// vanished shard is ignored: deletion surfaces via id events or reload.
    fn scan_shard(&mut self, io: &dyn Io, name: &str) {
        let Ok(files) = io.read_dir(&self.nodes_dir.join(name)) else {
            return;
        };
        for file in files {
            if is_node_file_name(&file.name) {
                let id = format!(
                    "{name}{}",
                    &file.name[..file.name.rfind('-').expect("shape checked")]
                );
                self.queue_inner(id);
            }
        }
    }

    fn reconcile_root(&mut self, sink: &mut dyn WatchSink, io: &dyn Io) {
        let entries: Vec<DirEntry> = match io.read_dir(&self.nodes_dir) {
            Ok(entries) => entries,
            Err(_) => return, // vanished root: the error handler keeps the watcher harmless
        };
        let mut touched = false;
        for entry in entries {
            if !entry.is_dir || !is_shard_name(&entry.name) {
                continue;
            }
            if self.watched_shards.iter().any(|s| s == &entry.name) {
                continue;
            }
            self.watch_shard(sink, &entry.name);
            self.scan_shard(io, &entry.name);
            self.mark_dirty(&entry.name);
            self.rescan_pending.push(entry.name.clone());
            touched = true;
        }
        if touched {
            self.schedule(sink);
        }
    }

    fn mark_dirty(&mut self, name: &str) {
        if !self.dirty_shards.iter().any(|s| s == name) {
            self.dirty_shards.push(name.to_string());
        }
    }

    fn queue(&mut self, sink: &mut dyn WatchSink, id: String) {
        self.queue_inner(id);
        self.schedule(sink);
    }

    fn queue_inner(&mut self, id: String) {
        if !self.pending.contains(&id) {
            self.pending.push(id);
        }
    }

    fn schedule(&mut self, sink: &mut dyn WatchSink) {
        sink.set_timer(TimerKind::Debounce, self.debounce_ms);
    }
}
