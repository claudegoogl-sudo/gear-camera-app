/**
 * Metro bundler config.
 *
 * This file previously did not exist — Expo fell back to its built-in default.
 * It exists now solely to pin `maxWorkers` (PAP-1661); everything else is
 * `expo/metro-config`'s default, unchanged.
 *
 * WHY: the Gradle bundle task forks `expo export:embed`, which is a Node
 * process. Metro then forks `maxWorkers` transformer child processes, sized by
 * metro-config's getMaxWorkers() off os.availableParallelism(). On this 8-CPU
 * host that is 6 extra Node processes, each with its own thread pool.
 *
 * The Gradle-side constraints (scripts/lib/gradle-constraints.sh and
 * mobile/plugins/withBuildHostGradleProps.js) cannot reach this: -XX flags
 * only bound JVMs, and Node does not read them. So the Metro half has to be
 * pinned here.
 *
 * The cap this defends is process/thread count, not memory: every agent on the
 * build host shares one cgroup with pids.max=600, and an unconstrained build
 * exhausts it with "unable to create native thread". See PAP-1661.
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 2, not 1: Metro treats maxWorkers === 1 as "transform in-band", which is a
// meaningfully different (and slower) code path. 2 keeps the normal worker
// path while costing 2 child processes instead of 6.
config.maxWorkers = 2;

module.exports = config;
