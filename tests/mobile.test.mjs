import test from "node:test";
import assert from "node:assert/strict";
import { extractCompletedSentences, stripMarkdownForSpeech } from "../src/speech-text.ts";
import { buildAuthHeaders, normalizeBaseUrl } from "../src/bridge-url.ts";
import { dispatchSseBlock, parseSseBlock, splitSseBuffer, splitSseText } from "../src/sse.ts";
import { DEFAULT_MOBILE_SETTINGS } from "../src/types.ts";

test("extractCompletedSentences splits streaming text cleanly", () => {
  const a = extractCompletedSentences("First sentence. Second", 0);
  assert.deepEqual(a.sentences, ["First sentence."]);
  const b = extractCompletedSentences("First sentence. Second one! Third?", a.nextCursor);
  assert.deepEqual(b.sentences, ["Second one!"]);
  const c = extractCompletedSentences("Line one\nLine two\nLine three", 0);
  assert.deepEqual(c.sentences, ["Line one", "Line two"]);
});

test("extractCompletedSentences handles empty remainder", () => {
  assert.deepEqual(extractCompletedSentences("abc.", 4), { sentences: [], nextCursor: 4 });
});

test("stripMarkdownForSpeech removes markdown notation cleanly", () => {
  const raw = "## Heading\n- Here is **the word** and *italic* with `code` and [a link](https://example.com).";
  assert.equal(
    stripMarkdownForSpeech(raw),
    "Heading Here is the word and italic with code and a link."
  );
});

test("stripMarkdownForSpeech omits code blocks", () => {
  assert.equal(stripMarkdownForSpeech("a\n```js\nx=1\n```\nb"), "a (code block omitted) b");
});

test("normalizeBaseUrl strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("http://h:8790///"), "http://h:8790");
  assert.equal(normalizeBaseUrl("http://h:8790"), "http://h:8790");
});

test("buildAuthHeaders adds a trimmed bearer token and merges extras", () => {
  assert.deepEqual(buildAuthHeaders("  tok \n", { A: "b" }), { Authorization: "Bearer tok", A: "b" });
  assert.deepEqual(buildAuthHeaders("   ", { A: "b" }), { A: "b" });
});

test("defaults: barge-in on, vadSilenceMs 1800", () => {
  assert.equal(DEFAULT_MOBILE_SETTINGS.voiceBargeIn, true);
  assert.equal(DEFAULT_MOBILE_SETTINGS.vadSilenceMs, 1800);
});

// ---- SSE parser ----

function collect(blocks) {
  const got = { session: [], text: [], done: [] };
  const h = {
    onSession: (s) => got.session.push(s),
    onText: (f, d) => got.text.push([f, d]),
    onDone: (s, t) => got.done.push([s, t]),
  };
  for (const b of blocks) dispatchSseBlock(b, h);
  return got;
}

test("sse: session/text/done events dispatch", () => {
  const got = collect([
    'event: session\ndata: {"sessionId":"s1"}',
    'event: text\ndata: {"fullText":"Hi","delta":"Hi"}',
    'event: done\ndata: {"sessionId":"s1","text":"Hi"}',
  ]);
  assert.deepEqual(got.session, ["s1"]);
  assert.deepEqual(got.text, [["Hi", "Hi"]]);
  assert.deepEqual(got.done, [["s1", "Hi"]]);
});

test("sse: error event throws", () => {
  assert.throws(() => dispatchSseBlock('event: error\ndata: {"error":"boom"}', {}), /boom/);
  assert.throws(() => dispatchSseBlock('event: error\ndata: {}', {}), /Chat error/);
});

test("sse: unknown events are ignored", () => {
  const got = collect(['event: tool_use\ndata: {"x":1}']);
  assert.deepEqual(got, { session: [], text: [], done: [] });
});

test("sse: keepalive comment and empty blocks are ignored", () => {
  const got = collect([": ping", ":keepalive\n", ""]);
  assert.deepEqual(got, { session: [], text: [], done: [] });
});

test("sse: missing event name defaults to message and is ignored", () => {
  assert.deepEqual(parseSseBlock('data: {"a":1}'), { event: "message", data: '{"a":1}' });
  assert.deepEqual(collect(['data: {"a":1}']), { session: [], text: [], done: [] });
});

test("sse: malformed JSON throws", () => {
  assert.throws(() => dispatchSseBlock("event: text\ndata: {nope", {}));
});

test("sse: splitSseBuffer keeps an incomplete tail", () => {
  const r = splitSseBuffer("event: a\ndata: {}\n\nevent: b\ndata: {");
  assert.deepEqual(r.blocks, ["event: a\ndata: {}"]);
  assert.equal(r.rest, "event: b\ndata: {");
});

test("sse: KNOWN BUG multiple data: lines keep only the last one", () => {
  // KNOWN BUG — flips in M5: should join with "\n" => '{"fullText":"A\nB"}'-style payloads
  const p = parseSseBlock('event: text\ndata: {"fullText":\ndata: "A"}');
  assert.equal(p.data, '"A"}');
  assert.throws(() => dispatchSseBlock('event: text\ndata: {"fullText":\ndata: "A"}', {}));
});

test("sse: CRLF line endings inside a block still parse (values are trimmed)", () => {
  const got = collect(['event: text\r\ndata: {"fullText":"x","delta":"x"}\r']);
  assert.deepEqual(got.text, [["x", "x"]]);
});

test("sse: KNOWN BUG \\r\\n\\r\\n separators are not recognized by the splitter", () => {
  // KNOWN BUG — flips in M5: a CRLF stream should yield 2 blocks, yields 0 complete blocks.
  const stream = 'event: text\r\ndata: {"fullText":"a","delta":"a"}\r\n\r\nevent: done\r\ndata: {"text":"a"}\r\n\r\n';
  const r = splitSseBuffer(stream);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.rest, stream);
  // KNOWN BUG — flips in M5: and the fallback path treats the whole text as one block (last data wins).
  assert.equal(splitSseText(stream).length, 1);
  const got = collect(splitSseText(stream));
  assert.equal(got.text.length, 0);
  assert.equal(got.done.length, 1);
});

test("sse: KNOWN BUG only \\n\\n splits blocks (no lone \\r separators)", () => {
  // KNOWN BUG — flips in M5
  assert.equal(splitSseText("a\r\rb").length, 1);
  assert.equal(splitSseText("a\n\nb").length, 2);
});
