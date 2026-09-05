import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RefinoStore } from "../src/store.js";
import { createConstraint, deleteNode, updateConstraint } from "../src/writer.js";
import { constraint, createRefino, premise, removeRefino } from "@refino/testkit";
import { IssueCode } from "refino";
import { StorageIssueCode } from "../src/codes.js";

/**
 * Resident projection behavior of the store (docs/design.md, "存储层
 * Store"): incremental updates through the single applyChange entry, no-op
 * suppression, parse-issue tracking and stale-file eviction.
 */

let root: string;
let refinoDir: string;

const P1 = "1A2B3C4D";
const C1 = "A1B2C3D4";

beforeAll(async () => {
  root = await createRefino({
    "nodes/1A/2B3C4D-premise.md": premise(P1, "前提一。"),
    "nodes/A1/B2C3D4-constraint.md": constraint(C1, [P1], "C1。"),
  });
  refinoDir = join(root, ".refino");
});

afterAll(async () => {
  await removeRefino(root);
});

describe("RefinoStore incremental updates", () => {
  it("suppresses no-op notifications and reports real changes and deletions", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();
      const start = store.revision;

      // Re-announcing an unchanged file is a no-op: no revision bump, no event.
      expect(await store.applyChange({ changed: [C1] })).toBeUndefined();
      expect(store.revision).toBe(start);

      // A real content change bumps the revision and reports the id.
      await updateConstraint(refinoDir, C1, { body: "增量更新的内容。", grounds: [P1] });
      const changed = await store.applyChange({ changed: [C1] });
      expect(changed).toEqual({
        revision: start + 1,
        changed: [C1],
        deleted: [],
        affected: [],
      });
      expect((await store.content(C1))?.body).toBe("增量更新的内容。");

      // An externally deleted file read back as absent turns into a deletion.
      await deleteNode(refinoDir, C1);
      const deleted = await store.applyChange({ changed: [C1] });
      expect(deleted).toEqual({
        revision: start + 2,
        changed: [],
        deleted: [C1],
        affected: [],
      });
      expect(store.entry(C1)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rechecks issues incrementally without a full reload", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();
      const newId = await createConstraint(refinoDir, { body: "悬空依据。", grounds: [P1] });
      await store.applyChange({ changed: [newId] });
      expect(store.issues().some((i) => i.code === IssueCode.UnknownGround)).toBe(false);

      // Break the ground externally: the dependent's issue must appear through
      // the same incremental entry, scoped to the affected nodes.
      await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: ["ZZZZZZZZ"] });
      await store.applyChange({ changed: [newId] });
      expect(
        store.issues().some((i) => i.code === IssueCode.UnknownGround && i.nodeId === newId),
      ).toBe(true);

      // Repairing the file clears the issue again.
      await updateConstraint(refinoDir, newId, { body: "悬空依据。", grounds: [P1] });
      await store.applyChange({ changed: [newId] });
      expect(store.issues()).toEqual([]);
      await deleteNode(refinoDir, newId);
      await store.applyChange({ changed: [newId] });
    } finally {
      store.close();
    }
  });

  it("surfaces parse issues from external changes without a reload", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();
      expect(store.issues()).toEqual([]);

      // A premise with an empty "summary" frontmatter field: a parse-level
      // issue invisible to the structural recheck, reported by readNode only.
      const shardDir = join(refinoDir, "nodes", "9A");
      await mkdir(shardDir, { recursive: true });
      await writeFile(
        join(shardDir, "ABCDEF1-premise.md"),
        '---\nsummary: ""\n---\n\n摘要字段为空的前提。\n',
        "utf8",
      );
      await store.applyChange({ changed: ["9AABCDEF1"] });
      expect(store.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

      // Repairing the file clears the issue through the same entry.
      await writeFile(join(shardDir, "ABCDEF1-premise.md"), "修复后的前提。\n", "utf8");
      const event = await store.applyChange({ changed: ["9AABCDEF1"] });
      expect(event?.changed).toEqual(["9AABCDEF1"]);
      expect(store.issues()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps a node's parse issues when only its dependents are rechecked", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();

      // P with a parse issue, grounded on by C: rechecking C (or any change
      // touching C) pulls P into the affected set and must not erase P's own
      // parse issue.
      const shardDir = join(refinoDir, "nodes", "9B");
      await mkdir(shardDir, { recursive: true });
      await writeFile(
        join(shardDir, "ABCDEF2-premise.md"),
        '---\nsummary: ""\n---\n\n带空摘要的前提。\n',
        "utf8",
      );
      const dependent = await createConstraint(refinoDir, {
        body: "下游。",
        grounds: ["9BABCDEF2"],
      });
      await store.applyChange({ changed: ["9BABCDEF2", dependent] });
      expect(store.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

      // A change to the dependent rechecks the premise too; its parse issue survives.
      await updateConstraint(refinoDir, dependent, { body: "下游改。", grounds: ["9BABCDEF2"] });
      await store.applyChange({ changed: [dependent] });
      expect(store.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

      await deleteNode(refinoDir, dependent);
      await store.applyChange({ changed: [dependent] });
    } finally {
      store.close();
    }
  });

  it("reports parse issues of files that yield no node at all", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();

      // Broken YAML: readNode returns no node but reports the parse issue,
      // keyed by file; the issue must surface through the incremental entry.
      const shardDir = join(refinoDir, "nodes", "9C");
      await mkdir(shardDir, { recursive: true });
      await writeFile(
        join(shardDir, "ABCDEF3-premise.md"),
        "---\n\t[broken yaml\n---\n\n正文。\n",
        "utf8",
      );
      const first = await store.applyChange({ changed: ["9CABCDEF3"] });
      expect(first).toBeDefined();
      expect(store.issues().some((i) => i.code === StorageIssueCode.InvalidFrontmatter)).toBe(true);

      // A no-op echo of the same broken file must not bump the revision.
      const revision = store.revision;
      expect(await store.applyChange({ changed: ["9CABCDEF3"] })).toBeUndefined();
      expect(store.revision).toBe(revision);
    } finally {
      store.close();
    }
  });

  it("drops parse issues keyed by files that vanish within a touched shard", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();

      // A lowercase id segment cannot form a valid id; the parse issue is keyed by file.
      const shardDir = join(refinoDir, "nodes", "AA");
      const badFile = join(shardDir, "zz-premise.md");
      await mkdir(shardDir, { recursive: true });
      await writeFile(badFile, "---\ntype: constraint\nsummary: 形状非法\n---\n正文。\n", "utf8");
      await store.reload();
      const invalidIssue = () => store.issues().find((i) => i.code === IssueCode.InvalidId);
      expect(invalidIssue()?.file).toBe("nodes/AA/zz-premise.md");

      // Renaming it into shape reports the new id; the touched shard lets the
      // store drop the stale file-keyed issue without a full reload.
      await rename(badFile, join(shardDir, "7P8Q9R-premise.md"));
      const event = await store.applyChange({ changed: ["AA7P8Q9R"], shards: ["AA"] });
      expect(event).toBeDefined();
      expect(store.entry("AA7P8Q9R")).toBeDefined();
      expect(invalidIssue()).toBeUndefined();

      // A shard-only batch without anything stale is a no-op.
      expect(await store.applyChange({ shards: ["AA"] })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects invalid grounds before persisting and never touches the disk", async () => {
    const store = RefinoStore.open(refinoDir);
    try {
      await store.ready();
      const start = store.revision;

      // Creation: an unknown ground is rejected with issues attached.
      await expect(
        store.createConstraint({ body: "新约束。", grounds: ["ZZZZZZZZ"] }),
      ).rejects.toMatchObject({
        name: "WriteRejected",
        issues: [{ code: IssueCode.UnknownGround, groundId: "ZZZZZZZZ" }],
      });

      // Update: a cycle-closing grounds change is rejected. (Earlier tests
      // in this file delete C1, so a fresh constraint carries the check.)
      const id = await createConstraint(refinoDir, { body: "环测试。", grounds: [P1] });
      await store.applyChange({ changed: [id] });
      await expect(
        store.updateConstraint(id, { body: "环测试。", grounds: [id] }),
      ).rejects.toMatchObject({ name: "WriteRejected", issues: [{ code: IssueCode.Cycle }] });

      // Only the applyChange of the created constraint bumped the revision;
      // the two rejected writes never touch it, so the grounds stay as
      // created.
      expect(store.revision).toBe(start + 1);
      expect(store.graph.nodes.get(id)?.grounds).toEqual([P1]);
    } finally {
      store.close();
    }
  });
});
