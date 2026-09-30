import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { roundtrip } from "../../src/model/document.ts";
import { BpmnEditError } from "../../src/utils/errors.ts";
import { FIXTURES, LARGE_MODEL, REPOSITORY_ROOT } from "../support/fixtures.ts";

/**
 * Every BPMN file in the canonical style of the modeler: the example content repo and the fixtures of this tool
 * (design, Camunda 7 and Camunda 8 files).
 */
const CANONICAL_DIRECTORIES = [join(REPOSITORY_ROOT, "process-documentation", "processes"), FIXTURES];
const TEST_MODEL = LARGE_MODEL;

function bpmnFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".bpmn"))
    .map((file) => join(directory, file));
}

const canonicalFiles = CANONICAL_DIRECTORIES.flatMap(bpmnFiles);

test("the canonical BPMN files of the repository are found", () => {
  assert.ok(canonicalFiles.length >= 5, `only ${canonicalFiles.length} files`);
});

for (const file of canonicalFiles) {
  test(`roundtrip keeps ${relative(REPOSITORY_ROOT, file)} byte for byte`, async () => {
    const xml = readFileSync(file, "utf8");

    assert.equal(await roundtrip(xml, file), xml);
  });
}

test(
  "roundtrip keeps the large test model byte for byte",
  { skip: !(TEST_MODEL && existsSync(TEST_MODEL)) && "BPMN_EDIT_LARGE_MODEL not set" },
  async () => {
    const xml = readFileSync(TEST_MODEL, "utf8");

    assert.equal(await roundtrip(xml, TEST_MODEL), xml);
  },
);

test("roundtrip drops XML comments: an edit through the object model loses them", async () => {
  const xml = readFileSync(join(FIXTURES, "planes.bpmn"), "utf8").replace(
    '<bpmn:process id="Process_Planes" isExecutable="true">',
    '<bpmn:process id="Process_Planes" isExecutable="true">\n    <!-- a note for readers -->',
  );

  assert.doesNotMatch(await roundtrip(xml, "commented.bpmn"), /a note for readers/);
});

test("roundtrip rejects a document that is not BPMN", async () => {
  await assert.rejects(roundtrip("<not-bpmn", "broken.bpmn"), BpmnEditError);
});
