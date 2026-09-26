import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { sleep } from "../../src/common/async.js";

test("sleep rejects existing cancellation and releases abort listeners", async () => {
  const cancelled = AbortSignal.abort();
  await assert.rejects(sleep(10_000, cancelled));
  await assert.rejects(sleep(0, cancelled));
  const controller = new AbortController();
  const pending = sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const active = new AbortController();
  await sleep(1, active.signal);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
});
