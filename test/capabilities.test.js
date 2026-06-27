import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const capabilitiesModule = await import(pathToFileURL(path.resolve("scripts/update-capabilities.js")).href);

const source = {
  id: "fixture",
  name: "Fixture docs",
  url: "https://example.test/fixture.md"
};

test("parseMarkdownSource extracts model aliases and conservative capability tags", () => {
  const markdown = `
## Microsoft models sold by Azure

| Model | Type | Capabilities |
| --- | --- | --- |
| \`Phi-4-mini-reasoning\` | chat-completion with reasoning content | - **Input:** text <br /> - **Tool calling:** No <br /> - **Response formats:** Text |
| \`Phi-4-multimodal-instruct\` | chat-completion | - **Input:** text, images, and audio <br /> - **Output:** text |

## Image generation models

| Model ID | Max request |
| --- | --- |
| \`gpt-image-1\` | 4,000 |
`;

  const entries = capabilitiesModule.parseMarkdownSource(source, markdown);

  assert.deepEqual(
    [...entries.get("phi4minireasoning").capabilities].sort(),
    ["reasoning", "tool-calling"]
  );
  assert.deepEqual(
    [...entries.get("phi4multimodalinstruct").capabilities].sort(),
    ["audio", "image"]
  );
  assert.deepEqual([...entries.get("gptimage1").capabilities], ["image"]);
});

test("generateCapabilityCatalog builds stable model map from injected markdown", async () => {
  const catalog = await capabilitiesModule.generateCapabilityCatalog({
    now: new Date("2026-06-27T00:00:00.000Z"),
    sources: [source],
    markdowns: {
      fixture: "| Model | Type | Capabilities |\n| --- | --- | --- |\n| `gpt-5` | chat | Reasoning <br> Structured outputs <br> Function calling |"
    }
  });

  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.generatedAt, "2026-06-27T00:00:00.000Z");
  assert.equal(catalog.modelCount, 1);
  assert.deepEqual(catalog.models.gpt5.capabilities, [
    "reasoning",
    "structured-outputs",
    "tool-calling"
  ]);
});
