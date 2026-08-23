/**
 * PAP-1675 sharded, resumable full-corpus audit.
 *
 * Same corpus, same selection order and same evalPhoto path as
 * pap760.audit.js — this only splits the 362 photos into SHARD_N contiguous
 * slices, and checkpoints every photo to a JSONL file as it completes.
 *
 * Two earlier whole-corpus runs were killed at heartbeat teardown and lost
 * everything. Per-photo checkpointing removes the need to survive teardown:
 * a relaunched shard skips the stamps already on disk and continues. Progress
 * is therefore monotone across any number of kills.
 *
 * Shards are contiguous over the stamp-sorted corpus, so concatenating
 * shard 0..N-1 reproduces the unsharded row order exactly.
 *
 * Run:
 *   SHARD_I=0 SHARD_N=4 npx jest --runTestsByPath mobile/__tests__/pap1675.shard.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const OUT_DIR = process.env.SHARD_OUT || '/tmp/pap1675_rows';

describe('PAP-1675 sharded audit', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('evaluate shard', () => {
    const shardI = Number(process.env.SHARD_I || 0);
    const shardN = Number(process.env.SHARD_N || 1);
    const { selected, total } = runner.selectCorpus({ scope: 'full' });

    // Contiguous split; earlier shards absorb the remainder.
    const per = Math.ceil(selected.length / shardN);
    const start = shardI * per;
    const slice = selected.slice(start, start + per);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const jsonl = path.join(OUT_DIR, `shard_${String(shardI).padStart(2, '0')}.jsonl`);

    // Resume: every stamp already checkpointed is skipped.
    const done = new Set();
    if (fs.existsSync(jsonl)) {
      for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { done.add(JSON.parse(line).stamp); } catch (_) { /* torn tail line */ }
      }
    }

    runner.out(
      `\n[pap1675] shard ${shardI + 1}/${shardN}: photos ${start}..${start + slice.length - 1} ` +
      `of ${selected.length} (corpus total ${total}); ${done.size} already checkpointed`,
    );

    const fd = fs.openSync(jsonl, 'a');
    const t0 = Date.now();
    let n = 0;
    for (let i = 0; i < slice.length; i++) {
      const { photo, actual, stamp } = slice[i];
      if (done.has(stamp)) continue;
      const r = runner.evalPhoto({ photo, actual, stamp });
      // Keep the audit fields plus the PAP-1659 instrument; drop `raw` so the
      // merged JSON stays small.
      const { raw, ...rest } = r;
      const row = {
        ...rest,
        idx: start + i,
        budgetExhausted: !!(raw && raw.budgetExhausted),
        centerMethod: (raw && raw.centerMethod) || '',
      };
      // Append + fsync per photo: a SIGTERM between photos costs at most the
      // photo in flight, never the shard.
      fs.writeSync(fd, JSON.stringify(row) + '\n');
      fs.fsyncSync(fd);
      n++;
      if (n % 5 === 0) {
        runner.out(`  [${i + 1}/${slice.length}] +${n} new, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
    fs.closeSync(fd);
    runner.out(
      `[pap1675] shard ${shardI} done: ${done.size + n}/${slice.length} rows on disk ` +
      `(+${n} this pass, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    expect(done.size + n).toBe(slice.length);
  });
});
