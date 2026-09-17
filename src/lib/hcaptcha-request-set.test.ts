import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StartedRequestSet } from './utils';

test('StartedRequestSet ignores finishes for requests it never saw start', () => {
  const set = new StartedRequestSet();
  const early = { id: 'early' };
  const live = { id: 'live' };
  assert.equal(set.end(early), true);
  assert.equal(set.seen, 0);
  assert.equal(set.idle, true);

  set.start(live);
  assert.equal(set.seen, 1);
  assert.equal(set.idle, false);
  assert.equal(set.end(early), false);
  assert.equal(set.idle, false);
  assert.equal(set.end(live), true);
  assert.equal(set.idle, true);
});

test('StartedRequestSet does not double-count the same request', () => {
  const set = new StartedRequestSet();
  const req = { id: 1 };
  set.start(req);
  set.start(req);
  assert.equal(set.seen, 1);
  assert.equal(set.end(req), true);
  assert.equal(set.end(req), true);
  assert.equal(set.idle, true);
});
