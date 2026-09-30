//! Hidden development tooling (`refino dev`), registered only when
//! `REFINO_DEV=true` so that production consumers never see the command at
//! all. The generator produces structurally valid DLG fixtures for manual
//! testing, demos and benchmarks; writes go through the store, so a generator
//! bug surfaces as a rejected write instead of corrupt data.

/// Parameters of `dev generate`.
pub struct GenerateDlgParams {
    /// Total number of nodes (premises + decisions).
    pub nodes: usize,
    /// Fraction of premises among all nodes, 0-1.
    pub premise_ratio: f64,
    /// Number of root decisions (empty grounds).
    pub roots: Option<usize>,
    /// Maximum number of grounds per non-root decision (>= 1).
    pub max_grounds: usize,
    /// Maximum decision-chain depth (>= 1); None is unlimited.
    pub max_depth: Option<usize>,
    /// Fraction of companion grounds drawn from shallower layers or premises,
    /// 0-1.
    pub cross_layer_ratio: f64,
    /// Fraction of premises carrying a confirmed timestamp, 0-1.
    pub confirmed_ratio: f64,
}

#[derive(Debug, Clone)]
pub struct GeneratedNode {
    pub node_type: refino_core::NodeType,
    pub id: String,
    pub summary: String,
    pub body: String,
    pub grounds: Option<Vec<String>>,
    pub rationale: Option<String>,
    pub confirmed: Option<i64>,
}

/// Build a random but structurally valid DLG as a topologically ordered node
/// list: premises first, then root decisions, then decisions grounding on
/// earlier ones (acyclic by construction). Deterministic given `rand`.
#[allow(clippy::too_many_lines)]
pub fn generate_dlq(
    params: &GenerateDlgParams,
    rand: &mut dyn FnMut() -> f64,
) -> Result<Vec<GeneratedNode>, String> {
    let premise_count = (params.nodes as f64 * params.premise_ratio).round() as usize;
    let decision_count = params.nodes - premise_count;
    let root_count = params.roots.unwrap_or(1);
    if root_count > decision_count {
        return Err(format!(
            "--roots {root_count} exceeds the {decision_count} decisions implied by --nodes and --premise-ratio"
        ));
    }
    // Non-root decisions need at least one ground source: a premise or a root
    // decision. Premises cannot ground, so with neither, generation is
    // impossible.
    if decision_count > 0 && premise_count == 0 && root_count == 0 {
        return Err(
            "nothing to ground on: --roots 0 combined with a premise ratio of 0 leaves no ground source"
                .to_string(),
        );
    }

    let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    fn next_id(
        used: &mut std::collections::HashSet<String>,
        rand: &mut dyn FnMut() -> f64,
    ) -> String {
        loop {
            let mut id = String::new();
            for _ in 0..8 {
                let index = (rand() * CROCKFORD_ALPHABET.len() as f64) as usize;
                id.push(CROCKFORD_ALPHABET.as_bytes()[index] as char);
            }
            if used.insert(id.clone()) {
                return id;
            }
        }
    }

    let mut nodes: Vec<GeneratedNode> = Vec::new();
    let confirmed_count = (premise_count as f64 * params.confirmed_ratio).round() as usize;
    // A fixed base keeps the output byte-identical across runs with the same
    // seed; spacing avoids identical timestamps for all premises.
    // Date.UTC(2026, 0, 1).
    const CONFIRMED_BASE_MS: i64 = 1_767_225_600_000;
    const DAY_MS: i64 = 86_400_000;
    for i in 0..premise_count {
        nodes.push(GeneratedNode {
            node_type: refino_core::NodeType::Premise,
            id: next_id(&mut used_ids, rand),
            summary: format!("dev premise #{i}"),
            body: format!(
                "Dev-generated premise #{i}.\n\nThis premise exists to populate a development graph; its content carries no meaning.\n"
            ),
            grounds: None,
            rationale: None,
            confirmed: if i < confirmed_count {
                Some(CONFIRMED_BASE_MS - i as i64 * DAY_MS)
            } else {
                None
            },
        });
    }

    let premise_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    // Longest decision-chain below each decision (roots: 0, premises ignored).
    let mut depths: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    // Decision ids per depth, in creation order; the last one is the newest.
    let mut layers: std::collections::BTreeMap<i64, Vec<String>> =
        std::collections::BTreeMap::new();

    for i in 0..root_count {
        let id = next_id(&mut used_ids, rand);
        depths.insert(id.clone(), 0);
        layers.entry(0).or_default().push(id.clone());
        nodes.push(GeneratedNode {
            node_type: refino_core::NodeType::Decision,
            id,
            summary: format!("dev decision #{i}"),
            body: format!(
                "Dev-generated decision #{i}.\n\nThis decision exists to populate a development graph; its content carries no meaning.\n"
            ),
            grounds: None,
            rationale: Some("dev-generated fixture data".to_string()),
            confirmed: None,
        });
    }
    for i in root_count..decision_count {
        let mut eligible_layers: Vec<(i64, Vec<String>)> = layers
            .iter()
            .filter(|(depth, _)| params.max_depth.is_none_or(|max| **depth < max as i64))
            .map(|(depth, ids)| (*depth, ids.clone()))
            .collect();
        eligible_layers.sort_by_key(|(depth, _)| *depth);
        if eligible_layers.is_empty() {
            // Only possible when no decision layer qualifies yet (e.g. --roots
            // 0 before any decision exists): ground on premises, which never
            // extend a chain.
            let mut sources = premise_ids.clone();
            let count =
                1 + (rand() * (params.max_grounds as f64).min(sources.len() as f64)) as usize;
            let grounds = take_distinct(&mut sources, count, rand);
            let id = next_id(&mut used_ids, rand);
            depths.insert(id.clone(), 0);
            layers.entry(0).or_default().push(id.clone());
            nodes.push(GeneratedNode {
                node_type: refino_core::NodeType::Decision,
                id,
                summary: format!("dev decision #{i}"),
                body: format!(
                    "Dev-generated decision #{i}.\n\nThis decision exists to populate a development graph; its content carries no meaning.\n"
                ),
                grounds: Some(grounds),
                rationale: Some("dev-generated fixture data".to_string()),
                confirmed: None,
            });
            continue;
        }
        // Deeper layers attract more refinements: square-bias the layer pick
        // toward the deep end (rand()² skews small, so count the index down
        // from the deepest).
        let layer_index = eligible_layers
            .len()
            .saturating_sub(1 + (rand() * rand() * eligible_layers.len() as f64) as usize);
        let anchor_layer = eligible_layers[layer_index].1.clone();
        let anchor = anchor_layer.last().cloned().expect("non-empty layer");
        // Real graphs ground mostly within one layer; only a minority of nodes
        // reach across to shallower layers or premises.
        let same_layer: Vec<String> = anchor_layer[..anchor_layer.len() - 1].to_vec();
        let mut cross_layer: Vec<String> = premise_ids.clone();
        for (_, ids) in &eligible_layers[..layer_index] {
            cross_layer.extend(ids.iter().cloned());
        }
        let cross_node = rand() < params.cross_layer_ratio;
        let count = 1 + (rand() * params.max_grounds as f64) as usize;
        let mut chosen = IndexSet::default();
        chosen.insert(anchor.clone());
        let mut pool = if cross_node { cross_layer } else { same_layer };
        let mut k = 1;
        while k < count && !pool.is_empty() {
            let at = (rand() * pool.len() as f64) as usize;
            chosen.insert(pool.remove(at));
            k += 1;
        }
        let grounds: Vec<String> = chosen.into_iter().collect();
        // TS: depth = 1 + max(-1, ...parentDepths) with -1 for premises.
        let parent_depth = grounds
            .iter()
            .map(|g| depths.get(g).copied().unwrap_or(-1))
            .max()
            .unwrap_or(-1);
        let depth = 1 + parent_depth.max(-1);
        let id = next_id(&mut used_ids, rand);
        depths.insert(id.clone(), depth);
        layers.entry(depth).or_default().push(id.clone());
        nodes.push(GeneratedNode {
            node_type: refino_core::NodeType::Decision,
            id,
            summary: format!("dev decision #{i}"),
            body: format!(
                "Dev-generated decision #{i}.\n\nThis decision exists to populate a development graph; its content carries no meaning.\n"
            ),
            grounds: Some(grounds),
            rationale: Some("dev-generated fixture data".to_string()),
            confirmed: None,
        });
    }
    Ok(nodes)
}

use indexmap_shim::IndexSet;

/// Minimal insertion-ordered set (the TS `Set` in `generateDlg`).
mod indexmap_shim {
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct IndexSet {
        map: HashMap<String, ()>,
        order: Vec<String>,
    }

    impl IndexSet {
        pub fn insert(&mut self, value: String) {
            if self.map.insert(value.clone(), ()).is_none() {
                self.order.push(value);
            }
        }

        pub fn into_iter(self) -> impl Iterator<Item = String> {
            self.order.into_iter()
        }
    }
}

/// Remove up to `count` random entries from `items` (mutates the vector).
fn take_distinct(items: &mut [String], count: usize, rand: &mut dyn FnMut() -> f64) -> Vec<String> {
    let mut picked = Vec::new();
    let mut pool: Vec<String> = items.to_vec();
    let mut taken = 0;
    while taken < count && !pool.is_empty() {
        let at = (rand() * pool.len() as f64) as usize;
        picked.push(pool.remove(at));
        taken += 1;
    }
    picked
}

/// Crockford base32 — the same alphabet the engine's generateId draws from.
const CROCKFORD_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Small seeded PRNG (mulberry32); good enough for fixtures, not crypto.
/// Bit-exact port of the TypeScript implementation.
pub fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// `refino dev generate`: generate a DLG fixture through the store's write
/// path, so a generator bug surfaces as a rejected write instead of corrupt
/// data.
pub fn cmd_dev_generate(
    io: &mut dyn crate::format::CliSink,
    opts: &crate::shared::GlobalOptions,
    params: &GenerateDlgParams,
    seed: Option<u32>,
    force: bool,
) -> i32 {
    use refino_storage::{CreateDecisionOptions, CreateOptions, CreatePremiseOptions, RefinoStore};

    // Resolve the seed up front so the output can report it even when it was
    // picked at random, keeping one-off runs reproducible after the fact.
    let seed = seed.unwrap_or_else(|| {
        let mut bytes = [0u8; 4];
        use refino_core::RandomSource as _;
        refino_fs::OsRandom.fill_bytes(&mut bytes);
        u32::from_le_bytes(bytes)
    });
    let refino_dir = crate::shared::refino_dir(opts);
    // Dev tooling is exempt from the adoption contract: generating fixtures
    // into a bare root is the point, so adopt unconditionally.
    if let Err(error) = std::fs::create_dir_all(refino_dir.join("nodes")) {
        io.err(&format!("error: {error}\n"));
        return 1;
    }
    let io_ = refino_fs::FsIo;
    let random = refino_fs::OsRandom;
    let mut store = RefinoStore::new(&io_, &random, refino_dir.clone());
    let result = (|| -> Result<i32, refino_storage::StoreError> {
        store.ready()?;
        if !store.graph().nodes.is_empty() && !force {
            io.err(&format!(
                "error: {} is not empty; use --force to add nodes anyway\n",
                refino_dir.display()
            ));
            return Ok(1);
        }
        let mut rand = mulberry32(seed);
        let generated = match generate_dlq(params, &mut rand) {
            Ok(nodes) => nodes,
            Err(message) => {
                io.err(&format!("error: {message}\n"));
                return Ok(1);
            }
        };
        for node in &generated {
            match node.node_type {
                refino_core::NodeType::Premise => {
                    store.create_premise(&CreatePremiseOptions {
                        base: CreateOptions {
                            body: node.body.clone(),
                            id: Some(node.id.clone()),
                            summary: Some(node.summary.clone()),
                        },
                        confirmed: node.confirmed,
                    })?;
                }
                refino_core::NodeType::Decision => {
                    store.create_decision(&CreateDecisionOptions {
                        base: CreateOptions {
                            body: node.body.clone(),
                            id: Some(node.id.clone()),
                            summary: Some(node.summary.clone()),
                        },
                        grounds: node.grounds.clone(),
                        rationale: node.rationale.clone(),
                        exploring: false,
                    })?;
                }
            }
        }
        let issues = store.issues();
        if !issues.is_empty() {
            // Unreachable unless the generator produces invalid graphs; a
            // rejected write fails earlier, so this only reports, never hides.
            io.out(&format!("{}\n", crate::format::render_issues(&issues)));
            return Ok(1);
        }
        let premises = generated
            .iter()
            .filter(|n| n.node_type == refino_core::NodeType::Premise)
            .count();
        let decisions = generated.len() - premises;
        let roots = generated
            .iter()
            .filter(|n| {
                n.node_type == refino_core::NodeType::Decision
                    && n.grounds.as_ref().is_none_or(|g| g.is_empty())
            })
            .count();
        io.out(&format!(
            "generated {premises} premises, {decisions} decisions ({roots} roots) in {} (seed {seed})\n",
            refino_dir.display()
        ));
        Ok(0)
    })();
    match result {
        Ok(code) => code,
        Err(failure) => {
            let message = match &failure {
                refino_storage::StoreError::Rejected(rejected) => rejected.to_string(),
                refino_storage::StoreError::Other(error) => error.message.clone(),
            };
            io.err(&format!("error: {message}\n"));
            1
        }
    }
}
