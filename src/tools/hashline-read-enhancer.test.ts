// Tests for hashline-read-enhancer (spec §16).

import { describe, expect, it } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeHash, parsePatch } from "./edit";
import {
  detectHashlineFormat,
  parseHashReference,
  applyHashlinePatches,
  readWithHashline,
  type HashlineDetection,
  type HashReference,
} from "./hashline-read-enhancer";

// ---------------------------------------------------------------------------
// detectHashlineFormat
// ---------------------------------------------------------------------------

describe("detectHashlineFormat", () => {
  it("detects valid hashline content", () => {
    const content = [
      "[src/foo.ts#a1b2]",
      "SWAP 1-2",
      "new line 1",
      "new line 2",
      "---",
    ].join("\n");
    const result = detectHashlineFormat(content);
    expect(result._tag).toBe("detected");
    if (result._tag === "detected") {
      expect(result.patches).toHaveLength(1);
      expect(result.patches[0].path).toBe("src/foo.ts");
      expect(result.patches[0].hash).toBe("a1b2");
      expect(result.headerCount).toBe(1);
    }
  });

  it("detects multiple patches", () => {
    const content = [
      "[src/foo.ts#a1b2]",
      "SWAP 1-1",
      "replaced",
      "---",
      "[src/bar.ts#c3d4]",
      "DEL 5-10",
      "---",
    ].join("\n");
    const result = detectHashlineFormat(content);
    expect(result._tag).toBe("detected");
    if (result._tag === "detected") {
      expect(result.patches).toHaveLength(2);
      expect(result.headerCount).toBe(2);
    }
  });

  it("returns not_detected for plain text", () => {
    const result = detectHashlineFormat("Hello world\nThis is a normal file");
    expect(result._tag).toBe("not_detected");
  });

  it("returns not_detected for header without operations", () => {
    const content = "[src/foo.ts#a1b2]\njust some text\n---";
    const result = detectHashlineFormat(content);
    expect(result._tag).toBe("not_detected");
  });

  it("detects INS.PRE operations", () => {
    const content = [
      "[src/foo.ts#abcd]",
      "INS.PRE 5",
      "inserted line",
      "---",
    ].join("\n");
    const result = detectHashlineFormat(content);
    expect(result._tag).toBe("detected");
  });

  it("detects DEL operations", () => {
    const content = [
      "[src/foo.ts#1234]",
      "DEL 3-7",
      "---",
    ].join("\n");
    const result = detectHashlineFormat(content);
    expect(result._tag).toBe("detected");
  });
});

// ---------------------------------------------------------------------------
// parseHashReference
// ---------------------------------------------------------------------------

describe("parseHashReference", () => {
  it("parses valid hash reference", () => {
    const result = parseHashReference("src/foo.ts#a1b2");
    expect(result._tag).toBe("valid");
    if (result._tag === "valid") {
      expect(result.path).toBe("src/foo.ts");
      expect(result.hash).toBe("a1b2");
    }
  });

  it("parses absolute path with hash", () => {
    const result = parseHashReference("/home/user/project/src/foo.ts#ff00");
    expect(result._tag).toBe("valid");
    if (result._tag === "valid") {
      expect(result.path).toBe("/home/user/project/src/foo.ts");
      expect(result.hash).toBe("ff00");
    }
  });

  it("rejects path without hash", () => {
    const result = parseHashReference("src/foo.ts");
    expect(result._tag).toBe("invalid");
  });

  it("rejects invalid hash format (non-hex)", () => {
    const result = parseHashReference("src/foo.ts#xyzw");
    expect(result._tag).toBe("invalid");
  });

  it("rejects hash of wrong length", () => {
    const result = parseHashReference("src/foo.ts#ab");
    expect(result._tag).toBe("invalid");
  });

  it("rejects hash of wrong length (5 chars)", () => {
    const result = parseHashReference("src/foo.ts#abcde");
    expect(result._tag).toBe("invalid");
  });

  it("rejects empty path", () => {
    const result = parseHashReference("#a1b2");
    expect(result._tag).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// applyHashlinePatches
// ---------------------------------------------------------------------------

describe("applyHashlinePatches", () => {
  it("applies SWAP patch", () => {
    const fileContent = "line 1\nline 2\nline 3";
    const hash = computeHash(fileContent);
    const patches = parsePatch(`[file.txt#${hash}]\nSWAP 2-2\nreplaced line\n---`);
    const result = applyHashlinePatches(fileContent, patches);
    expect(result.appliedCount).toBe(1);
    expect(result.content).toBe("line 1\nreplaced line\nline 3");
    expect(result.errors).toHaveLength(0);
  });

  it("reports hash mismatch errors", () => {
    const fileContent = "line 1\nline 2\nline 3";
    const patches = parsePatch("[file.txt#ffff]\nSWAP 2-2\nreplaced\n---");
    const result = applyHashlinePatches(fileContent, patches);
    expect(result.appliedCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("hash mismatch");
  });

  it("applies DEL patch", () => {
    const fileContent = "line 1\nline 2\nline 3\nline 4";
    const hash = computeHash(fileContent);
    const patches = parsePatch(`[file.txt#${hash}]\nDEL 2-3\n---`);
    const result = applyHashlinePatches(fileContent, patches);
    expect(result.appliedCount).toBe(1);
    expect(result.content).toBe("line 1\nline 4");
  });

  it("applies INS.POST patch", () => {
    const fileContent = "line 1\nline 2";
    const hash = computeHash(fileContent);
    const patches = parsePatch(`[file.txt#${hash}]\nINS.POST 1\ninserted\n---`);
    const result = applyHashlinePatches(fileContent, patches);
    expect(result.appliedCount).toBe(1);
    expect(result.content).toBe("line 1\ninserted\nline 2");
  });

  it("applies patches to different files", () => {
    const contentA = "aaa\nbbb";
    const contentB = "xxx\nyyy";
    const hashA = computeHash(contentA);
    const hashB = computeHash(contentB);
    const patches = parsePatch(
      `[fileA.txt#${hashA}]\nSWAP 1-1\nAAA\n---\n[fileB.txt#${hashB}]\nSWAP 2-2\nYYY\n---`,
    );
    const resultA = applyHashlinePatches(contentA, patches.filter((p) => p.path === "fileA.txt"));
    const resultB = applyHashlinePatches(contentB, patches.filter((p) => p.path === "fileB.txt"));
    expect(resultA.appliedCount).toBe(1);
    expect(resultA.content).toBe("AAA\nbbb");
    expect(resultB.appliedCount).toBe(1);
    expect(resultB.content).toBe("xxx\nYYY");
  });
});

// ---------------------------------------------------------------------------
// readWithHashline
// ---------------------------------------------------------------------------

describe("readWithHashline", () => {
  const testDir = join(tmpdir(), "hashline-read-test-" + Date.now());

  async function setupTestFile(name: string, content: string): Promise<string> {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, name);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("reads plain file", async () => {
    const filePath = await setupTestFile("plain.txt", "hello world\nline 2");
    const result = await readWithHashline(filePath);
    expect(result._tag).toBe("plain");
    if (result._tag === "plain") {
      expect(result.content).toBe("hello world\nline 2");
      expect(result.bytes).toBe(18);
      expect(result.totalLines).toBe(2);
    }
  });

  it("reads with hash verification (matching)", async () => {
    const content = "test content";
    const filePath = await setupTestFile("verify.txt", content);
    const hash = computeHash(content);
    const result = await readWithHashline(filePath, { expectedHash: hash });
    expect(result._tag).toBe("hash_verified");
    if (result._tag === "hash_verified") {
      expect(result.verified).toBe(true);
      expect(result.hash).toBe(hash);
      expect(result.actualHash).toBe(hash);
    }
  });

  it("reads with hash verification (mismatch)", async () => {
    const filePath = await setupTestFile("mismatch.txt", "content");
    const result = await readWithHashline(filePath, { expectedHash: "dead" });
    expect(result._tag).toBe("hash_verified");
    if (result._tag === "hash_verified") {
      expect(result.verified).toBe(false);
    }
  });

  it("auto-detects hashline format", async () => {
    const hashlineContent = "[some/file.ts#a1b2]\nSWAP 1-1\nreplaced\n---";
    const filePath = await setupTestFile("patch.txt", hashlineContent);
    const result = await readWithHashline(filePath, { applyPatches: true });
    // Should detect but fail to apply (target file doesn't exist)
    expect(result._tag).toBe("patch_failed");
    if (result._tag === "patch_failed") {
      expect(result.patches).toHaveLength(1);
      expect(result.error).toContain("not found");
    }
  });

  it("applies hashline patches to target file", async () => {
    const original = "first\nsecond\nthird";
    const targetPath = await setupTestFile("target.ts", original);
    const hash = computeHash(original);
    const patchContent = `[${targetPath}#${hash}]\nSWAP 2-2\nSECOND\n---`;
    const patchPath = await setupTestFile("patch.txt", patchContent);
    const result = await readWithHashline(patchPath, { applyPatches: true });
    expect(result._tag).toBe("patch_applied");
    if (result._tag === "patch_applied") {
      expect(result.content).toBe("first\nSECOND\nthird");
      expect(result.appliedCount).toBe(1);
    }
  });
});
