import { Option } from "commander";
import { Command } from "commander";
import { searchNodes, type SearchPage } from "@refino/harness";
import { emit, withStore } from "../shared.js";
import type { GlobalOptions, RunFn } from "../shared.js";
import { frozenIds } from "../frozen.js";
import { renderNodeTable } from "../format.js";
import type { CliIo } from "../format.js";

const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 500;

interface SearchOptions {
  type?: "premise" | "constraint";
  limit?: string;
  cursor?: string;
  roots?: boolean;
  unreferenced?: boolean;
}

/**
 * `refino search` — paginated id/summary search for navigating large graphs
 * where `refino list` is unusable. Matching semantics align with the web
 * API's `GET /api/search` (id prefixes case-insensitively, summary
 * substrings, keyset cursor); `--roots` / `--unreferenced` are the web
 * endpoint's project-overview and maintenance filters.
 */
export function createSearchCommand(io: CliIo, run: RunFn): Command {
  return new Command("search")
    .description("paginated search over id prefixes and summaries")
    .argument("[query]", "id prefix or summary substring (empty matches everything)")
    .addOption(
      new Option("--type <type>", "only search nodes of this type").choices([
        "premise",
        "constraint",
      ]),
    )
    .option("--limit <n>", `page size (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`)
    .option("--cursor <id>", "resume strictly after this id (keyset pagination)")
    .option("--roots", "only root constraints (grounds-less); project-overview entry points")
    .option("--unreferenced", "only premises no constraint grounds on")
    .action((query: string | undefined, _opts, cmd: Command) =>
      run(cmd, (opts: GlobalOptions) =>
        withStore(io, opts, async (store) => {
          const o = cmd.opts() as SearchOptions;
          const rawLimit = Number(o.limit);
          const limit = Number.isInteger(rawLimit)
            ? Math.min(Math.max(rawLimit, 1), SEARCH_MAX_LIMIT)
            : SEARCH_DEFAULT_LIMIT;
          // `searchNodes` owns matching and pagination; the roots and
          // unreferenced filters are projection-level, so they post-filter
          // one page at the source of truth (the graph) instead.
          const page = searchNodes(store.graph, {
            q: query ?? "",
            type: o.type,
            limit: SEARCH_MAX_LIMIT,
            cursor: o.cursor,
          });
          const nodeById = new Map(store.graph.nodes);
          const filtered = page.nodes.filter((entry) => {
            const node = nodeById.get(entry.id)!;
            if (o.roots && (node.type !== "constraint" || node.grounds.length > 0)) return false;
            if (o.unreferenced && (node.type !== "premise" || node.children.length > 0)) {
              return false;
            }
            return true;
          });
          // More pages exist when the filtered page overflows the requested
          // size, or when the raw window was full (matching rows may continue
          // beyond it): the cursor is the last emitted id either way.
          const rawFull = page.nodes.length >= SEARCH_MAX_LIMIT;
          const overflow = filtered.length > limit;
          const nextCursor =
            filtered.length === 0
              ? undefined
              : overflow || rawFull
                ? filtered[Math.min(limit, filtered.length) - 1]!.id
                : undefined;
          const result: SearchPage = {
            query: query ?? "",
            nodes: filtered.slice(0, limit),
            ...(nextCursor !== undefined && { next_cursor: nextCursor }),
          };
          if (opts.json) {
            emit(io, result);
          } else if (result.nodes.length === 0) {
            io.stdout.write("(no matches)\n");
          } else {
            // Text rows carry the frozen mark (docs/design.md, 上下文注入协议);
            // the JSON shape is the SearchPage contract shared with the web API.
            const frozen = await frozenIds(store.graph, opts);
            io.stdout.write(
              `${renderNodeTable(result.nodes.map((n) => ({ ...n, frozen: frozen.has(n.id) })))}\n`,
            );
            if (result.next_cursor !== undefined) {
              io.stdout.write(`(more results; continue with --cursor ${result.next_cursor})\n`);
            }
          }
          return 0;
        }),
      ),
    );
}
