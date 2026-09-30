//! The notify-backed host adapters: filesystem watches forwarded into the
//! storage watcher state machine, and watcher batches fed back into the
//! store's single incremental entry, then broadcast over SSE.

use refino_fs::FsIo;
use refino_storage::{Origin, TimerKind, WatchError, WatchSink, WatcherCore};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// What the notify callbacks forward into the driver loop.
enum Raw {
    Root(Option<String>),
    Shard { shard: String, filename: Option<String> },
    Timer(TimerKind),
}

/// The watch handles plus the event channel. Cloned handles share the
/// channel; dropping the whole set releases the watches.
struct NotifySink {
    watches: Mutex<Vec<notify::RecommendedWatcher>>,
    tx: tokio::sync::mpsc::UnboundedSender<Raw>,
}

impl NotifySink {
    fn arm(&self, path: PathBuf, translate: impl Fn(Option<String>) -> Raw + Send + 'static) -> Result<(), WatchError> {
        let tx = self.tx.clone();
        let watcher = notify::recommended_watcher(
            move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else { return };
                let filename = event
                    .paths
                    .first()
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
                let _ = tx.send(translate(filename));
            },
        )
        .map_err(|error| refino_fs::watch_error_class(&error))?;
        // Note: notify watches must be kept alive; `watch` returns a handle we
        // store. `notify::RecommendedWatcher::watch` starts immediately on
        // construction with `Config`, so use the manual watch call here.
        let mut handle = watcher;
        handle
            .watch(&path, notify::RecursiveMode::NonRecursive)
            .map_err(|error| refino_fs::watch_error_class(&error))?;
        self.watches.lock().expect("watches").push(handle);
        Ok(())
    }
}

impl WatchSink for NotifySink {
    fn watch_dir(&mut self, path: &Path) -> Result<(), WatchError> {
        let is_root = path.file_name().is_none_or(|n| n != "nodes") && path.ends_with("nodes");
        if is_root {
            self.arm(
                path.to_path_buf(),
                Box::new(|filename| Raw::Root(filename)),
            )
        } else {
            let shard = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            self.arm(
                path.to_path_buf(),
                Box::new(move |filename| Raw::Shard { shard: shard.clone(), filename }),
            )
        }
    }

    fn unwatch_dir(&mut self, _path: &Path) {
        // The state machine drops shard records on close; notify handles are
        // released with the sink.
    }

    fn set_timer(&mut self, kind: TimerKind, delay_ms: u64) {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let _ = tx.send(Raw::Timer(kind));
        });
    }

    fn cancel_timer(&mut self, _kind: TimerKind) {
        // Ticks on a closed core are inert; cancelling is a no-op like the
        // unref'd timers of the TS implementation.
    }
}

/// What the watcher loop needs from the server state.
pub struct WatchTarget {
    pub store: Arc<Mutex<refino_storage::RefinoStore<FsIo>>>,
    pub changes: tokio::sync::broadcast::Sender<crate::ChangeFeed>,
}

/// Keep-alive handle: dropping it closes the watcher.
pub struct WatchGuard {
    close: Box<dyn FnOnce() + Send>,
}

impl WatchGuard {
    pub fn close(self) {
        (self.close)();
    }
}

/// Arm the notify watcher over `nodes_dir` and feed its batches back into the
/// store behind `target`, then broadcast them over the change feed. Returns
/// None when arming failed permanently (the server degrades to manual
/// reload); transient exhaustion retries in the background inside the core.
pub fn start(nodes_dir: PathBuf, target: Arc<WatchTarget>) -> Option<WatchGuard> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(Mutex::new(NotifySink {
        watches: Mutex::new(Vec::new()),
        tx,
    }));

    let store_for_batches = target.store.clone();
    let changes_for_batches = target.changes.clone();
    let mut core = WatcherCore::new(nodes_dir.clone(), refino_storage::DEFAULT_DEBOUNCE_MS, {
        move |ids, shards| {
            let Ok(mut store) = store_for_batches.lock() else { return };
            let change = store
                .apply_change(ids, &[], shards, Some(Origin::File))
                .ok()
                .flatten();
            drop(store);
            if let Some(change) = change {
                let _ = changes_for_batches.send(crate::change_feed(&change));
            }
        }
    });

    let mut sink_guard = sink.lock().expect("sink").clone_shallow();
    // Arm against a shallow clone so the shared channel forwards events.
    let arm_result = {
        let mut shallow = ShallowSink(sink.clone());
        core.arm(&mut shallow, &FsIo, false)
    };
    match arm_result {
        refino_storage::ArmResult::Armed => {}
        refino_storage::ArmResult::Transient => {
            let mut shallow = ShallowSink(sink.clone());
            core.schedule_retry(&mut shallow);
        }
        refino_storage::ArmResult::GiveUp => return None,
    }

    let core = Arc::new(Mutex::new(core));
    let core_for_loop = core.clone();
    let sink_for_loop = sink.clone();
    let nodes_for_loop = nodes_dir.clone();
    tokio::spawn(async move {
        while let Some(raw) = rx.recv().await {
            let Ok(mut core) = core_for_loop.lock() else { return };
            let mut shallow = ShallowSink(sink_for_loop.clone());
            match raw {
                Raw::Root(filename) => core.on_root_event(filename.as_deref(), &mut shallow, &FsIo),
                Raw::Shard { shard, filename } => {
                    core.on_shard_event(&shard, filename.as_deref(), &mut shallow, &FsIo)
                }
                Raw::Timer(kind) => core.on_timer(kind, &mut shallow, &FsIo),
            }
            let _ = &nodes_for_loop;
        }
    });

    Some(WatchGuard {
        close: Box::new(move || {
            let Ok(mut core) = core.lock() else { return };
            let mut shallow = ShallowSink(sink.clone());
            core.close(&mut shallow);
        }),
    })
}

/// A shared-sink view for the `&mut dyn WatchSink` calls: the underlying
/// notify handles live behind the shared `NotifySink`.
struct ShallowSink(Arc<Mutex<NotifySink>>);

impl WatchSink for ShallowSink {
    fn watch_dir(&mut self, path: &Path) -> Result<(), WatchError> {
        self.0.lock().expect("sink").watch_dir(path)
    }

    fn unwatch_dir(&mut self, path: &Path) {
        self.0.lock().expect("sink").unwatch_dir(path)
    }

    fn set_timer(&mut self, kind: TimerKind, delay_ms: u64) {
        self.0.lock().expect("sink").set_timer(kind, delay_ms)
    }

    fn cancel_timer(&mut self, kind: TimerKind) {
        self.0.lock().expect("sink").cancel_timer(kind)
    }
}

impl NotifySink {
    fn clone_shallow(&self) -> NotifySinkShallow {
        NotifySinkShallow(self.tx.clone())
    }
}

/// The channel-only view (arming happens through `ShallowSink`).
struct NotifySinkShallow(tokio::sync::mpsc::UnboundedSender<Raw>);
